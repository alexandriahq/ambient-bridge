import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  type BridgeFrame,
  type BridgeCancelFrame,
  type BridgeBinaryFrame,
  type BridgeRequestFrame,
  type JsonValue,
} from "./protocol.js";
import { ReplayCache, verifyLocalRequest } from "./auth.js";
import type { PairingStore } from "./pairing.js";
import type { AuditSink } from "../diagnostics/audit.js";
import { errorMessage } from "../error-message.js";

export type IpcStream = AsyncIterable<JsonValue | undefined>;
export type IpcHandlerResult = JsonValue | undefined | IpcStream;
export type IpcHandlerContext = {
  readBinaryUpload: (options?: BinaryUploadReadOptions) => Promise<Buffer>;
  /** Resolves when the requesting socket closes; lets long-lived streams end. */
  socketClosed?: Promise<void>;
};
export type IpcMethodHandler = (frame: BridgeRequestFrame, context: IpcHandlerContext) => IpcHandlerResult | Promise<IpcHandlerResult>;
export type IpcWritable = Pick<Socket, "write">;

export type BinaryUploadReadOptions = {
  readonly expectedByteLength?: number;
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
};

// Binary uploads are buffered in memory until the owning handler reads them.
// The only upload type today (audio transcription) is capped at 6 MiB by its
// signed metadata; this server-level ceiling bounds buffering for any upload
// before a handler enforces its own limit.
const MAX_BINARY_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_BINARY_UPLOADS_PER_SOCKET = 4;

export type BridgeIpcServerOptions = {
  socketPath: string;
  pairingStore: PairingStore;
  handlers: Record<string, IpcMethodHandler>;
  publicMethods?: Set<string>;
  audit: AuditSink;
};

export class BridgeIpcServer {
  private server?: Server;
  private readonly replayCache = new ReplayCache();
  private readonly publicMethods: Set<string>;
  private readonly binaryUploads = new Map<string, BinaryUploadState>();

  constructor(private readonly options: BridgeIpcServerOptions) {
    this.publicMethods = options.publicMethods ?? new Set(["bridge.health", "pair.start", "pair.complete"]);
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  async start(): Promise<void> {
    if (!isWindowsPipePath(this.options.socketPath)) {
      await mkdir(dirname(this.options.socketPath), { recursive: true });
      await rm(this.options.socketPath, { force: true });
    }

    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.socketPath, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    if (!isWindowsPipePath(this.options.socketPath)) {
      await rm(this.options.socketPath, { force: true });
    }
  }

  private handleSocket(socket: Socket): void {
    const decoder = new FrameDecoder();
    // Without a listener, a peer disconnecting while we write (EPIPE,
    // write-after-destroy) raises an unhandled 'error' event and crashes the
    // process.
    socket.on("error", (error) => {
      this.options.audit.record("ipc.socket_error", { message: errorMessage(error) });
    });
    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.on("close", () => {
      for (const [id, upload] of this.binaryUploads) {
        if (upload.socket !== socket) continue;
        this.failBinaryUpload(upload, new Error("Bridge IPC connection closed during binary upload."));
        this.binaryUploads.delete(id);
        this.options.audit.record("ipc.binary_upload_dropped", { id, reason: "connection_closed" });
      }
    });
    socket.on("data", (chunk) => {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const frame of decoder.push(buffer)) {
          void this.handleFrame(socket, frame, socketClosed);
        }
      } catch (error) {
        this.options.audit.record("ipc.frame_error", { message: errorMessage(error) });
        socket.destroy();
      }
    });
  }

  private async handleFrame(socket: Socket, frame: BridgeFrame, socketClosed?: Promise<void>): Promise<void> {
    if (frame.type === "cancel") {
      await this.handleCancelFrame(socket, frame);
      return;
    }

    if (frame.type === "binary") {
      this.handleBinaryFrame(socket, frame);
      return;
    }

    if (frame.type !== "request") {
      return;
    }

    const handler = this.options.handlers[frame.method];
    if (!handler) {
      this.options.audit.record("ipc.unknown_method", { method: frame.method });
      socket.write(encodeFrame({ type: "error", id: frame.id, code: "unknown_method", message: frame.method }));
      return;
    }

    this.options.audit.record("ipc.request", { method: frame.method });

    if (!this.publicMethods.has(frame.method)) {
      const credential = frame.auth
        ? this.options.pairingStore.findCredential(frame.auth.credentialId)
        : undefined;
      const auth = verifyLocalRequest({
        auth: frame.auth,
        credential,
        method: frame.method,
        payload: frame.payload,
        replayCache: this.replayCache,
      });

      if (!auth.ok) {
        this.options.audit.record("ipc.unauthorized", { method: frame.method, reason: auth.reason });
        socket.write(encodeFrame({ type: "error", id: frame.id, code: auth.reason, message: "Unauthorized" }));
        return;
      }
    }

    if (frame.method === "inference.audioTranscriptions") {
      this.openBinaryUpload(socket, frame.id);
    }

    try {
      const context: IpcHandlerContext = {
        readBinaryUpload: (options) => this.readBinaryUpload(frame.id, options),
        socketClosed,
      };
      const result = await handler(frame, context);
      await writeIpcHandlerResult({
        audit: this.options.audit,
        frame,
        result,
        socket,
      });
    } catch (error) {
      this.options.audit.record("ipc.handler_error", {
        message: errorMessage(error),
        method: frame.method,
      });
      socket.write(encodeFrame({
        type: "error",
        id: frame.id,
        code: "handler_error",
        message: safeHandlerErrorMessage(error),
      }));
    } finally {
      if (frame.method === "inference.audioTranscriptions") {
        this.binaryUploads.delete(frame.id);
      }
    }
  }

  private openBinaryUpload(socket: Socket, id: string): void {
    let active = 0;
    for (const upload of this.binaryUploads.values()) {
      if (upload.socket === socket) active += 1;
    }
    const state: BinaryUploadState = {
      bytes: 0,
      chunks: [],
      ended: false,
      expectedSeq: 0,
      socket,
      waiters: [],
    };
    if (active >= MAX_BINARY_UPLOADS_PER_SOCKET) {
      state.error = new Error(`Too many concurrent binary uploads (limit ${MAX_BINARY_UPLOADS_PER_SOCKET}).`);
      this.options.audit.record("ipc.binary_upload_rejected", { id, reason: "concurrency_limit" });
    }
    this.binaryUploads.set(id, state);
  }

  private handleBinaryFrame(socket: Socket, frame: BridgeBinaryFrame): void {
    const upload = this.binaryUploads.get(frame.id);
    if (!upload) {
      this.options.audit.record("ipc.binary_orphan", { id: frame.id });
      return;
    }
    if (upload.socket !== socket) {
      this.options.audit.record("ipc.binary_orphan", { id: frame.id, reason: "wrong_connection" });
      return;
    }
    if (upload.error || upload.ended) return;
    if (frame.seq !== upload.expectedSeq) {
      this.failBinaryUpload(upload, new Error("Binary IPC frame sequence is invalid."));
      return;
    }
    upload.expectedSeq += 1;
    if (frame.event === "chunk") {
      upload.chunks.push(frame.bytes);
      upload.bytes += frame.bytes.byteLength;
      if (upload.bytes > MAX_BINARY_UPLOAD_BYTES) {
        this.failBinaryUpload(upload, new Error(`Binary upload exceeds ${MAX_BINARY_UPLOAD_BYTES} bytes.`));
        return;
      }
    } else {
      upload.ended = true;
    }
    this.resolveBinaryWaiters(upload);
  }

  private readBinaryUpload(id: string, options: BinaryUploadReadOptions = {}): Promise<Buffer> {
    const upload = this.binaryUploads.get(id);
    if (!upload) return Promise.reject(new Error("Binary upload was not opened for this IPC request."));
    if (options.maxBytes !== undefined && upload.bytes > options.maxBytes) {
      this.failBinaryUpload(upload, new Error(`Binary upload exceeds ${options.maxBytes} bytes.`));
    }
    if (upload.error) return Promise.reject(upload.error);
    if (upload.ended) return Promise.resolve(this.finishBinaryUpload(upload, options));
    return new Promise<Buffer>((resolve, reject) => {
      upload.waiters.push({ options, reject, resolve });
    });
  }

  private resolveBinaryWaiters(upload: BinaryUploadState): void {
    if (!upload.ended && !upload.error) return;
    const waiters = upload.waiters.splice(0);
    for (const waiter of waiters) {
      if (upload.error) {
        waiter.reject(upload.error);
      } else {
        try {
          waiter.resolve(this.finishBinaryUpload(upload, waiter.options));
        } catch (error) {
          waiter.reject(error);
        }
      }
    }
  }

  private failBinaryUpload(upload: BinaryUploadState, error: Error): void {
    upload.error = error;
    upload.chunks = [];
    upload.bytes = 0;
    this.resolveBinaryWaiters(upload);
  }

  private finishBinaryUpload(upload: BinaryUploadState, options: BinaryUploadReadOptions): Buffer {
    const bytes = Buffer.concat(upload.chunks, upload.bytes);
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
      throw new Error(`Binary upload exceeds ${options.maxBytes} bytes.`);
    }
    if (options.expectedByteLength !== undefined && bytes.byteLength !== options.expectedByteLength) {
      throw new Error("Binary upload byte length does not match signed metadata.");
    }
    if (options.expectedSha256) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== options.expectedSha256) {
        throw new Error("Binary upload hash does not match signed metadata.");
      }
    }
    return bytes;
  }

  private async handleCancelFrame(socket: Socket, frame: BridgeCancelFrame): Promise<void> {
    const payload: JsonValue = { requestId: frame.id };
    const credential = frame.auth
      ? this.options.pairingStore.findCredential(frame.auth.credentialId)
      : undefined;
    const auth = verifyLocalRequest({
      auth: frame.auth,
      credential,
      method: "inference.cancel",
      payload,
      replayCache: this.replayCache,
    });

    if (!auth.ok) {
      this.options.audit.record("ipc.unauthorized", { method: "inference.cancel", reason: auth.reason });
      socket.write(encodeFrame({ type: "error", id: frame.id, code: auth.reason, message: "Unauthorized" }));
      return;
    }

    const handler = this.options.handlers["inference.cancel"];
    if (!handler) {
      socket.write(encodeFrame({ type: "error", id: frame.id, code: "unknown_method", message: "inference.cancel" }));
      return;
    }

    this.options.audit.record("ipc.cancel", { id: frame.id });
    try {
      const result = await handler({
        auth: frame.auth,
        id: frame.id,
        method: "inference.cancel",
        payload,
        type: "request",
      }, {
        readBinaryUpload: () => Promise.reject(new Error("Binary uploads are not available for cancellation.")),
      });
      await writeIpcHandlerResult({
        audit: this.options.audit,
        frame: { id: frame.id, method: "inference.cancel" },
        result,
        socket,
      });
    } catch (error) {
      this.options.audit.record("ipc.handler_error", {
        message: errorMessage(error),
        method: "inference.cancel",
      });
      socket.write(encodeFrame({
        type: "error",
        id: frame.id,
        code: "handler_error",
        message: safeHandlerErrorMessage(error),
      }));
    }
  }
}

type BinaryUploadState = {
  bytes: number;
  chunks: Buffer[];
  ended: boolean;
  error?: Error;
  expectedSeq: number;
  socket: Socket;
  waiters: Array<{
    options: BinaryUploadReadOptions;
    resolve: (value: Buffer) => void;
    reject: (error: unknown) => void;
  }>;
};

export async function writeIpcHandlerResult(input: {
  readonly audit: AuditSink;
  readonly frame: Pick<BridgeRequestFrame, "id" | "method">;
  readonly result: IpcHandlerResult;
  readonly socket: IpcWritable;
}): Promise<void> {
  if (!isAsyncIterable(input.result)) {
    input.audit.record("ipc.response", { method: input.frame.method });
    input.socket.write(encodeFrame({ type: "response", id: input.frame.id, payload: input.result }));
    return;
  }

  input.audit.record("ipc.stream_start", { method: input.frame.method });
  input.socket.write(encodeFrame({ type: "stream", id: input.frame.id, event: "start" }));
  try {
    for await (const payload of input.result) {
      input.socket.write(encodeFrame({ type: "stream", id: input.frame.id, event: "delta", payload }));
    }
    input.audit.record("ipc.stream_end", { method: input.frame.method });
    input.socket.write(encodeFrame({ type: "stream", id: input.frame.id, event: "end" }));
  } catch (error) {
    input.audit.record("ipc.stream_error", { method: input.frame.method, message: errorMessage(error) });
    input.socket.write(encodeFrame({
      type: "error",
      id: input.frame.id,
      code: "handler_error",
      message: safeHandlerErrorMessage(error),
    }));
  }
}


function safeHandlerErrorMessage(error: unknown): string {
  const message = errorMessage(error).trim();
  return (message || "Bridge handler failed").slice(0, 500);
}

function isWindowsPipePath(socketPath: string): boolean {
  return socketPath.startsWith("\\\\.\\pipe\\");
}

function isAsyncIterable(value: IpcHandlerResult): value is IpcStream {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function";
}

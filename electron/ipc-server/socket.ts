import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
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
  /** Verified owner for authenticated methods. */
  credentialId?: string;
  readBinaryUpload: (options?: BinaryUploadReadOptions) => Promise<Buffer>;
  /** Resolves when the requesting socket closes; lets long-lived streams end. */
  socketClosed?: Promise<void>;
};
export type IpcMethodHandler = (frame: BridgeRequestFrame, context: IpcHandlerContext) => IpcHandlerResult | Promise<IpcHandlerResult>;
export type IpcWritable = Pick<Socket, "write">
  & Partial<Pick<Socket, "destroyed" | "writableEnded" | "once" | "off">>;

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
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private readonly sockets = new Set<Socket>();
  private readonly replayCache = new ReplayCache();
  private readonly publicMethods: Set<string>;
  private readonly binaryUploads = new Map<Socket, Map<string, BinaryUploadState>>();

  constructor(private readonly options: BridgeIpcServerOptions) {
    this.publicMethods = options.publicMethods ?? new Set(["bridge.health", "pair.start", "pair.complete"]);
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (!isWindowsPipePath(this.options.socketPath)) {
      await mkdir(dirname(this.options.socketPath), { recursive: true });
      await rm(this.options.socketPath, { force: true });
    }

    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      if (this.server === server) this.server = undefined;
      throw error;
    }
    if (!isWindowsPipePath(this.options.socketPath)) {
      try {
        await chmod(this.options.socketPath, 0o600);
      } catch (error) {
        this.options.audit.record("ipc.socket_chmod_failed", { message: errorMessage(error) });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = undefined;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    const server = this.server;
    this.server = undefined;
    const closePromise = server?.listening
      ? new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
      : Promise.resolve();

    // `net.Server.close()` waits for accepted connections. Bridge intentionally
    // has long-lived status streams, so close them explicitly; their close event
    // resolves `socketClosed` and releases handler/binary-upload state.
    for (const socket of this.sockets) {
      this.dropSocketUploads(socket, "server_stopped");
      socket.destroy();
    }

    await closePromise;
    if (!isWindowsPipePath(this.options.socketPath)) {
      await rm(this.options.socketPath, { force: true });
    }
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    const binaryUploads = new Map<string, BinaryUploadState>();
    this.binaryUploads.set(socket, binaryUploads);
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
      this.sockets.delete(socket);
      this.dropSocketUploads(socket, "connection_closed");
    });
    socket.on("data", (chunk) => {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const frame of decoder.push(buffer)) {
          void this.handleFrame(socket, binaryUploads, frame, socketClosed);
        }
      } catch (error) {
        this.options.audit.record("ipc.frame_error", { message: errorMessage(error) });
        socket.destroy();
      }
    });
  }

  private async handleFrame(
    socket: Socket,
    binaryUploads: Map<string, BinaryUploadState>,
    frame: BridgeFrame,
    socketClosed?: Promise<void>,
  ): Promise<void> {
    if (frame.type === "cancel") {
      await this.handleCancelFrame(socket, frame);
      return;
    }

    if (frame.type === "binary") {
      this.handleBinaryFrame(binaryUploads, frame);
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

    let credentialId: string | undefined;
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
      credentialId = auth.credentialId;
    }

    let binaryUploadOpened = false;
    try {
      if (frame.method === "inference.audioTranscriptions") {
        this.openBinaryUpload(binaryUploads, frame.id);
        binaryUploadOpened = true;
      }
      const context: IpcHandlerContext = {
        credentialId,
        readBinaryUpload: (options) => this.readBinaryUpload(binaryUploads, frame.id, options),
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
      if (binaryUploadOpened) {
        binaryUploads.delete(frame.id);
      }
    }
  }

  private openBinaryUpload(binaryUploads: Map<string, BinaryUploadState>, id: string): void {
    if (binaryUploads.has(id)) {
      throw new Error("Binary upload request id is already active on this connection.");
    }
    const state: BinaryUploadState = {
      bytes: 0,
      chunks: [],
      ended: false,
      expectedSeq: 0,
      waiters: [],
    };
    if (binaryUploads.size >= MAX_BINARY_UPLOADS_PER_SOCKET) {
      state.error = new Error(`Too many concurrent binary uploads (limit ${MAX_BINARY_UPLOADS_PER_SOCKET}).`);
      this.options.audit.record("ipc.binary_upload_rejected", { id, reason: "concurrency_limit" });
    }
    binaryUploads.set(id, state);
  }

  private handleBinaryFrame(binaryUploads: Map<string, BinaryUploadState>, frame: BridgeBinaryFrame): void {
    const upload = binaryUploads.get(frame.id);
    if (!upload) {
      this.options.audit.record("ipc.binary_orphan", { id: frame.id });
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

  private readBinaryUpload(
    binaryUploads: Map<string, BinaryUploadState>,
    id: string,
    options: BinaryUploadReadOptions = {},
  ): Promise<Buffer> {
    const upload = binaryUploads.get(id);
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

  private dropSocketUploads(socket: Socket, reason: "connection_closed" | "server_stopped"): void {
    const uploads = this.binaryUploads.get(socket);
    if (!uploads) return;
    this.binaryUploads.delete(socket);
    for (const [id, upload] of uploads) {
      this.failBinaryUpload(upload, new Error("Bridge IPC connection closed during binary upload."));
      this.options.audit.record("ipc.binary_upload_dropped", { id, reason });
    }
    uploads.clear();
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
        credentialId: auth.credentialId,
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
    try {
      await writeIpcFrame(input.socket, { type: "response", id: input.frame.id, payload: input.result });
    } catch (error) {
      if (error instanceof IpcSocketClosedError) {
        input.audit.record("ipc.response_cancelled", { method: input.frame.method, reason: "connection_closed" });
        return;
      }
      throw error;
    }
    return;
  }

  input.audit.record("ipc.stream_start", { method: input.frame.method });
  try {
    await writeIpcFrame(input.socket, { type: "stream", id: input.frame.id, event: "start" });
    for await (const payload of input.result) {
      await writeIpcFrame(input.socket, { type: "stream", id: input.frame.id, event: "delta", payload });
    }
    input.audit.record("ipc.stream_end", { method: input.frame.method });
    await writeIpcFrame(input.socket, { type: "stream", id: input.frame.id, event: "end" });
  } catch (error) {
    if (error instanceof IpcSocketClosedError) {
      input.audit.record("ipc.stream_cancelled", { method: input.frame.method, reason: "connection_closed" });
      return;
    }
    input.audit.record("ipc.stream_error", { method: input.frame.method, message: errorMessage(error) });
    try {
      await writeIpcFrame(input.socket, {
        type: "error",
        id: input.frame.id,
        code: "handler_error",
        message: safeHandlerErrorMessage(error),
      });
    } catch (writeError) {
      if (!(writeError instanceof IpcSocketClosedError)) throw writeError;
    }
  }
}

class IpcSocketClosedError extends Error {
  constructor() {
    super("Bridge IPC connection closed while writing a response.");
    this.name = "IpcSocketClosedError";
  }
}

async function writeIpcFrame(
  socket: IpcWritable,
  frame: Exclude<BridgeFrame, BridgeBinaryFrame>,
): Promise<void> {
  if (socket.destroyed || socket.writableEnded) throw new IpcSocketClosedError();

  let writable: boolean;
  try {
    writable = socket.write(encodeFrame(frame));
  } catch (error) {
    if (socket.destroyed || socket.writableEnded || isClosedSocketWriteError(error)) {
      throw new IpcSocketClosedError();
    }
    throw error;
  }
  if (!writable) await waitForSocketDrain(socket);
}

function waitForSocketDrain(socket: IpcWritable): Promise<void> {
  if (socket.destroyed || socket.writableEnded) return Promise.reject(new IpcSocketClosedError());
  if (!socket.once || !socket.off) {
    return Promise.reject(new Error("IPC writer returned backpressure without lifecycle event support."));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off?.("drain", onDrain);
      socket.off?.("close", onClose);
      socket.off?.("error", onError);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onDrain = (): void => settle(resolve);
    const onClose = (): void => settle(() => reject(new IpcSocketClosedError()));
    const onError = (): void => settle(() => reject(new IpcSocketClosedError()));

    socket.once?.("drain", onDrain);
    socket.once?.("close", onClose);
    socket.once?.("error", onError);
    // Close can race the listener registration after `write()` returned false.
    if (socket.destroyed || socket.writableEnded) onClose();
  });
}

function isClosedSocketWriteError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return new Set([
    "ECONNRESET",
    "EPIPE",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END",
  ]).has(String(error.code));
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

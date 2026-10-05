import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import { PairingStore } from "../electron/ipc-server/pairing.js";
import { encodeBinaryFrame, encodeFrame, FrameDecoder } from "../electron/ipc-server/protocol.js";
import { BridgeIpcServer, writeIpcHandlerResult } from "../electron/ipc-server/socket.js";
import { BridgeInferenceServiceError } from "../electron/inference/errors.js";

describe("Bridge IPC server socket lifecycle", () => {
  it.skipIf(process.platform === "win32")("rebinds the socket after the file is externally removed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-ipc-rebind-"));
    const server = new BridgeIpcServer({
      audit: new MemoryAuditSink(),
      handlers: { "bridge.health": async () => ({ ok: true }) },
      pairingStore: new PairingStore(),
      socketPath: path.join(dir, "bridge.sock"),
    });

    try {
      await server.start();
      expect(existsSync(server.socketPath)).toBe(true);

      // Another Bridge instance starting or quitting used to rm the shared
      // socket file out from under the live listener.
      await rm(server.socketPath, { force: true });
      expect(existsSync(server.socketPath)).toBe(false);

      await server.stop();
      await server.start();
      expect(existsSync(server.socketPath)).toBe(true);
    } finally {
      await server.stop();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("starts and stops idempotently", async () => {
    const dir = process.platform === "win32"
      ? null
      : await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-ipc-idempotent-"));
    const server = new BridgeIpcServer({
      audit: new MemoryAuditSink(),
      handlers: { "bridge.health": async () => ({ ok: true }) },
      pairingStore: new PairingStore(),
      socketPath: testSocketPath(dir, "idempotent"),
    });

    try {
      await Promise.all([server.start(), server.start()]);
      const client = createConnection(server.socketPath);
      await once(client, "connect");
      client.destroy();
      await Promise.all([server.stop(), server.stop()]);
      await server.stop();
    } finally {
      await server.stop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
  });

  it("restarts when start races an in-progress stop", async () => {
    const dir = process.platform === "win32"
      ? null
      : await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-ipc-restart-race-"));
    const server = new BridgeIpcServer({
      audit: new MemoryAuditSink(),
      handlers: { "bridge.health": async () => ({ ok: true }) },
      pairingStore: new PairingStore(),
      socketPath: testSocketPath(dir, "restart-race"),
    });

    try {
      await server.start();
      const firstClient = createConnection(server.socketPath);
      firstClient.on("error", () => undefined);
      await once(firstClient, "connect");

      await Promise.all([server.stop(), server.start()]);

      const secondClient = createConnection(server.socketPath);
      await once(secondClient, "connect");
      secondClient.destroy();
    } finally {
      await server.stop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
  });

  it("stops with a live status stream and signals socketClosed", async () => {
    const dir = process.platform === "win32"
      ? null
      : await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-ipc-live-stream-"));
    let socketClosedObserved!: () => void;
    const socketClosedWasObserved = new Promise<void>((resolve) => {
      socketClosedObserved = resolve;
    });
    const server = new BridgeIpcServer({
      audit: new MemoryAuditSink(),
      handlers: {
        "bridge.statusSubscribe": async function* (_frame, context) {
          yield { status: "ready" };
          await context.socketClosed;
          socketClosedObserved();
        },
      },
      pairingStore: new PairingStore(),
      publicMethods: new Set(["bridge.statusSubscribe"]),
      socketPath: testSocketPath(dir, "live-stream"),
    });

    try {
      await server.start();
      const client = createConnection(server.socketPath);
      client.on("error", () => undefined);
      await once(client, "connect");
      client.write(encodeFrame({ type: "request", id: "status-1", method: "bridge.statusSubscribe" }));
      await once(client, "data");

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        server.stop().then(() => "stopped"),
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(outcome).toBe("stopped");
      await socketClosedWasObserved;
      expect(client.destroyed).toBe(true);
    } finally {
      await server.stop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
  });
});

function testSocketPath(dir: string | null, suffix: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ambient-bridge-ipc-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return path.join(dir!, "bridge.sock");
}

describe("Bridge IPC server result writer", () => {
  it("decodes binary upload frames", () => {
    const decoder = new FrameDecoder();
    const frame = {
      bytes: Buffer.from("audio bytes"),
      event: "chunk",
      id: "req_audio",
      seq: 2,
      type: "binary",
    } as const;

    expect(decoder.push(encodeBinaryFrame(frame))).toEqual([frame]);
  });

  it("streams async handler results as start, delta, and end frames", async () => {
    const chunks: Buffer[] = [];
    const audit = new MemoryAuditSink();

    const outcome = await writeIpcHandlerResult({
      audit,
      frame: { id: "req_stream", method: "inference.responses" },
      result: (async function* () {
        yield { kind: "openai.response.chunk", data: "one" };
        yield { kind: "openai.response.chunk", data: "two" };
      })(),
      socket: {
        write: (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
      },
    });

    const decoder = new FrameDecoder();
    const frames = chunks.flatMap((chunk) => decoder.push(chunk));

    expect(frames).toEqual([
      { event: "start", id: "req_stream", type: "stream" },
      { event: "delta", id: "req_stream", payload: { kind: "openai.response.chunk", data: "one" }, type: "stream" },
      { event: "delta", id: "req_stream", payload: { kind: "openai.response.chunk", data: "two" }, type: "stream" },
      { event: "end", id: "req_stream", type: "stream" },
    ]);
    expect(outcome).toBe("success");
    expect(audit.recent()).toEqual([]);
  });

  it("pauses a response stream until a backpressured socket drains", async () => {
    const chunks: Buffer[] = [];
    const events = new EventEmitter();
    let writes = 0;
    let pulls = 0;
    let releaseBackpressure!: () => void;
    const backpressureObserved = new Promise<void>((resolve) => {
      releaseBackpressure = resolve;
    });
    const socket = Object.assign(events, {
      destroyed: false,
      writableEnded: false,
      write: (chunk: Uint8Array | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        writes += 1;
        if (writes === 2) {
          releaseBackpressure();
          return false;
        }
        return true;
      },
    });

    const pending = writeIpcHandlerResult({
      audit: new MemoryAuditSink(),
      frame: { id: "req_slow_reader", method: "inference.responses" },
      result: (async function* () {
        pulls += 1;
        yield { data: "one" };
        pulls += 1;
        yield { data: "two" };
      })(),
      socket,
    });

    await backpressureObserved;
    await Promise.resolve();
    expect(pulls).toBe(1);
    expect(writes).toBe(2);

    events.emit("drain");
    await expect(pending).resolves.toBe("success");

    expect(pulls).toBe(2);
    const decoder = new FrameDecoder();
    expect(chunks.flatMap((chunk) => decoder.push(chunk))).toEqual([
      { event: "start", id: "req_slow_reader", type: "stream" },
      { event: "delta", id: "req_slow_reader", payload: { data: "one" }, type: "stream" },
      { event: "delta", id: "req_slow_reader", payload: { data: "two" }, type: "stream" },
      { event: "end", id: "req_slow_reader", type: "stream" },
    ]);
  });

  it("cancels a backpressured response stream when the socket closes", async () => {
    const audit = new MemoryAuditSink();
    const events = new EventEmitter();
    let writes = 0;
    let iteratorFinalized = false;
    let releaseBackpressure!: () => void;
    const backpressureObserved = new Promise<void>((resolve) => {
      releaseBackpressure = resolve;
    });
    const socket = Object.assign(events, {
      destroyed: false,
      writableEnded: false,
      write: () => {
        writes += 1;
        if (writes === 2) {
          releaseBackpressure();
          return false;
        }
        return true;
      },
    });

    const pending = writeIpcHandlerResult({
      audit,
      frame: { id: "req_disconnected_reader", method: "inference.responses" },
      result: (async function* () {
        try {
          yield { data: "one" };
          yield { data: "two" };
        } finally {
          iteratorFinalized = true;
        }
      })(),
      socket,
    });

    await backpressureObserved;
    socket.destroyed = true;
    events.emit("close");
    await expect(pending).resolves.toBe("cancelled");

    expect(iteratorFinalized).toBe(true);
    expect(writes).toBe(2);
    expect(audit.recent()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "ipc.stream_cancelled",
        fields: expect.objectContaining({ reason: "connection_closed" }),
      }),
    ]));
  });

  it("returns the sanitized stream failure message to the requester", async () => {
    const chunks: Buffer[] = [];

    const outcome = await writeIpcHandlerResult({
      audit: new MemoryAuditSink(),
      frame: { id: "req_stream_error", method: "inference.responses" },
      result: (async function* () {
        yield { kind: "openai.response.chunk", data: "one" };
        throw new Error("Tinfoil secure request failed: Missing Ehbp-Response-Nonce header");
      })(),
      socket: {
        write: (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
      },
    });

    const decoder = new FrameDecoder();
    const frames = chunks.flatMap((chunk) => decoder.push(chunk));

    expect(frames).toEqual([
      { event: "start", id: "req_stream_error", type: "stream" },
      { event: "delta", id: "req_stream_error", payload: { kind: "openai.response.chunk", data: "one" }, type: "stream" },
      {
        code: "handler_error",
        id: "req_stream_error",
        message: "Tinfoil secure request failed: Missing Ehbp-Response-Nonce header",
        type: "error",
      },
    ]);
    expect(outcome).toBe("failure");
  });

  it("preserves a stable provider-service code across the typed IPC error frame", async () => {
    const chunks: Buffer[] = [];
    await writeIpcHandlerResult({
      audit: new MemoryAuditSink(),
      frame: { id: "req_provider_billing", method: "inference.responses" },
      result: (async function* () {
        throw new BridgeInferenceServiceError("UPSTREAM_BILLING_UNAVAILABLE", 503, 60);
      })(),
      socket: {
        write: (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
      },
    });

    const frames = chunks.flatMap((chunk) => new FrameDecoder().push(chunk));
    expect(frames.at(-1)).toEqual({
      code: "UPSTREAM_BILLING_UNAVAILABLE",
      id: "req_provider_billing",
      message: "AI processing is temporarily unavailable. Try again shortly; if this continues, contact Ambient support. (UPSTREAM_BILLING_UNAVAILABLE)",
      type: "error",
    });
  });

  it("bounds returned stream failure messages", async () => {
    const chunks: Buffer[] = [];

    await writeIpcHandlerResult({
      audit: new MemoryAuditSink(),
      frame: { id: "req_long_error", method: "inference.responses" },
      result: (async function* () {
        throw new Error("x".repeat(600));
      })(),
      socket: {
        write: (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
      },
    });

    const decoder = new FrameDecoder();
    const frames = chunks.flatMap((chunk) => decoder.push(chunk));

    expect(frames.at(-1)).toEqual({
      code: "handler_error",
      id: "req_long_error",
      message: "x".repeat(500),
      type: "error",
    });
  });
});

it("disposes an admitted stream if the first socket write cannot start", async () => {
  let pulls = 0, disposed = 0;
  const result = {
    [Symbol.asyncIterator]() { return this; },
    async next() { pulls++; return {done: false as const, value: {data: "unused"}}; },
    async return() { disposed++; throw new Error("secondary cleanup failure"); },
  };
  const outcome = await writeIpcHandlerResult({
    audit: new MemoryAuditSink(), frame: {id:"unstarted", method:"inference.responses"}, result,
    socket: {destroyed:true, write() {throw new Error("must not write closed socket");}},
  });
  expect(outcome).toBe("cancelled");
  expect(pulls).toBe(0);
  expect(disposed).toBe(1);
});

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import { PairingStore } from "../electron/ipc-server/pairing.js";
import { encodeBinaryFrame, FrameDecoder } from "../electron/ipc-server/protocol.js";
import { BridgeIpcServer, writeIpcHandlerResult } from "../electron/ipc-server/socket.js";

describe("Bridge IPC server socket lifecycle", () => {
  it("rebinds the socket after the file is externally removed", async () => {
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
});

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

    await writeIpcHandlerResult({
      audit: new MemoryAuditSink(),
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
  });

  it("returns the sanitized stream failure message to the requester", async () => {
    const chunks: Buffer[] = [];

    await writeIpcHandlerResult({
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

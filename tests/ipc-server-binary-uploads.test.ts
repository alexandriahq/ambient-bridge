import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import { PairingStore } from "../electron/ipc-server/pairing.js";
import { encodeBinaryFrame, encodeFrame } from "../electron/ipc-server/protocol.js";
import { BridgeIpcServer, type IpcHandlerContext } from "../electron/ipc-server/socket.js";

const UPLOAD_METHOD = "inference.audioTranscriptions";

type Harness = {
  server: BridgeIpcServer;
  client: Socket;
  audit: MemoryAuditSink;
  reads: Map<string, Promise<Buffer>>;
  cleanup: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-binary-"));
  const audit = new MemoryAuditSink();
  const reads = new Map<string, Promise<Buffer>>();
  const server = new BridgeIpcServer({
    audit,
    handlers: {
      [UPLOAD_METHOD]: async (frame, context: IpcHandlerContext) => {
        const read = context.readBinaryUpload();
        reads.set(frame.id, read);
        // Swallow here; tests assert on the stored promise.
        await read.catch(() => undefined);
        return {};
      },
    },
    pairingStore: new PairingStore(),
    publicMethods: new Set([UPLOAD_METHOD]),
    socketPath: path.join(dir, "bridge.sock"),
  });
  await server.start();
  const client = createConnection(server.socketPath);
  client.on("error", () => undefined);
  await once(client, "connect");
  const cleanup = async (): Promise<void> => {
    client.destroy();
    await server.stop();
    await rm(dir, { force: true, recursive: true });
  };
  cleanups.push(cleanup);
  return { server, client, audit, reads, cleanup };
}

function requestUpload(client: Socket, id: string): void {
  client.write(encodeFrame({ type: "request", id, method: UPLOAD_METHOD }));
}

// Wraps the read promise in an object so awaiting the lookup does not also
// await (and auto-flatten) the pending read itself.
async function readFor(
  reads: Map<string, Promise<Buffer>>,
  id: string,
  timeoutMs = 2_000,
): Promise<{ read: Promise<Buffer> }> {
  const deadline = Date.now() + timeoutMs;
  while (!reads.has(id)) {
    if (Date.now() > deadline) throw new Error(`handler for ${id} never started`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { read: reads.get(id)! };
}

describe("Bridge IPC binary upload lifecycle", () => {
  it("fails pending uploads and frees buffers when the connection drops mid-upload", async () => {
    const { client, audit, reads } = await startHarness();

    requestUpload(client, "up-disconnect");
    client.write(encodeBinaryFrame({
      type: "binary",
      id: "up-disconnect",
      event: "chunk",
      seq: 0,
      bytes: Buffer.from("partial audio"),
    }));
    const { read } = await readFor(reads, "up-disconnect");

    client.destroy();

    await expect(read).rejects.toThrow(/connection closed during binary upload/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(audit.recent().some((event) => event.name === "ipc.binary_upload_dropped")).toBe(true);
  });

  it("rejects uploads above the per-connection concurrency limit", async () => {
    const { client, reads } = await startHarness();

    for (let i = 0; i < 5; i += 1) {
      requestUpload(client, `up-${i}`);
    }

    const { read: rejected } = await readFor(reads, "up-4");
    await expect(rejected).rejects.toThrow(/Too many concurrent binary uploads/);

    // The first four uploads are still alive and complete normally.
    client.write(encodeBinaryFrame({
      type: "binary",
      id: "up-0",
      event: "chunk",
      seq: 0,
      bytes: Buffer.from("ok"),
    }));
    client.write(encodeBinaryFrame({ type: "binary", id: "up-0", event: "end", seq: 1, bytes: Buffer.alloc(0) }));
    const { read: first } = await readFor(reads, "up-0");
    await expect(first).resolves.toEqual(Buffer.from("ok"));
  });

  it("fails uploads that exceed the server-level byte ceiling", async () => {
    const { client, reads } = await startHarness();

    requestUpload(client, "up-big");
    const { read } = await readFor(reads, "up-big");
    const chunk = Buffer.alloc(6 * 1024 * 1024, 1);
    for (let seq = 0; seq < 3; seq += 1) {
      client.write(encodeBinaryFrame({ type: "binary", id: "up-big", event: "chunk", seq, bytes: chunk }));
    }

    await expect(read).rejects.toThrow(/Binary upload exceeds/);
  });
});

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../electron/diagnostics/audit.js";
import { PairingStore } from "../electron/ipc-server/pairing.js";
import { encodeBinaryFrame, encodeFrame } from "../electron/ipc-server/protocol.js";
import { BridgeIpcServer, type IpcHandlerContext, type BinaryUploadReadOptions } from "../electron/ipc-server/socket.js";

const UPLOAD_METHOD = "inference.audioTranscriptions";

type Harness = {
  server: BridgeIpcServer;
  client: Socket;
  audit: MemoryAuditSink;
  reads: Map<string, Array<Promise<Buffer>>>;
  cleanup: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startHarness(options: (id: string) => BinaryUploadReadOptions = () => ({})): Promise<Harness> {
  const dir = process.platform === "win32"
    ? null
    : await mkdtemp(path.join(os.tmpdir(), "ambient-bridge-binary-"));
  const audit = new MemoryAuditSink();
  const reads = new Map<string, Array<Promise<Buffer>>>();
  const server = new BridgeIpcServer({
    audit,
    handlers: {
      [UPLOAD_METHOD]: async (frame, context: IpcHandlerContext) => {
        const read = context.readBinaryUpload(options(frame.id));
        reads.set(frame.id, [...(reads.get(frame.id) ?? []), read]);
        // Swallow here; tests assert on the stored promise.
        await read.catch(() => undefined);
        return {};
      },
    },
    pairingStore: new PairingStore(),
    publicMethods: new Set([UPLOAD_METHOD]),
    socketPath: testSocketPath(dir),
  });
  await server.start();
  const client = createConnection(server.socketPath);
  client.on("error", () => undefined);
  await once(client, "connect");
  const cleanup = async (): Promise<void> => {
    client.destroy();
    await server.stop();
    if (dir) await rm(dir, { force: true, recursive: true });
  };
  cleanups.push(cleanup);
  return { server, client, audit, reads, cleanup };
}

function testSocketPath(dir: string | null): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ambient-bridge-binary-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return path.join(dir!, "bridge.sock");
}

function requestUpload(client: Socket, id: string): void {
  client.write(encodeFrame({ type: "request", id, method: UPLOAD_METHOD }));
}

// Wraps the read promise in an object so awaiting the lookup does not also
// await (and auto-flatten) the pending read itself.
async function readFor(
  reads: Map<string, Array<Promise<Buffer>>>,
  id: string,
  index = 0,
  timeoutMs = 2_000,
): Promise<{ read: Promise<Buffer> }> {
  const deadline = Date.now() + timeoutMs;
  while ((reads.get(id)?.length ?? 0) <= index) {
    if (Date.now() > deadline) throw new Error(`handler for ${id} never started`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { read: reads.get(id)![index]! };
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

  it("isolates identical binary request ids across client sockets", async () => {
    const { server, client: firstClient, reads } = await startHarness();
    const secondClient = createConnection(server.socketPath);
    secondClient.on("error", () => undefined);
    await once(secondClient, "connect");
    cleanups.push(async () => {
      secondClient.destroy();
    });

    requestUpload(firstClient, "shared-id");
    const { read: firstRead } = await readFor(reads, "shared-id", 0);
    requestUpload(secondClient, "shared-id");
    const { read: secondRead } = await readFor(reads, "shared-id", 1);

    firstClient.write(encodeBinaryFrame({
      type: "binary",
      id: "shared-id",
      event: "chunk",
      seq: 0,
      bytes: Buffer.from("first"),
    }));
    firstClient.write(encodeBinaryFrame({
      type: "binary",
      id: "shared-id",
      event: "end",
      seq: 1,
      bytes: Buffer.alloc(0),
    }));
    secondClient.write(encodeBinaryFrame({
      type: "binary",
      id: "shared-id",
      event: "chunk",
      seq: 0,
      bytes: Buffer.from("second"),
    }));
    secondClient.write(encodeBinaryFrame({
      type: "binary",
      id: "shared-id",
      event: "end",
      seq: 1,
      bytes: Buffer.alloc(0),
    }));

    await expect(firstRead).resolves.toEqual(Buffer.from("first"));
    await expect(secondRead).resolves.toEqual(Buffer.from("second"));
  });
});

it("cancellation settles incomplete upload readers and releases connection capacity", async () => {
  const controllers = new Map(Array.from({ length: 4 }, (_, index) => [`cancel-${index}`, new AbortController()]));
  const { client, reads } = await startHarness(id => ({ signal: controllers.get(id)?.signal }));
  const outcomes: unknown[] = [];
  for (const [id] of controllers) {
    requestUpload(client, id);
    client.write(encodeBinaryFrame({ type: "binary", id, event: "chunk", seq: 0, bytes: Buffer.from("partial") }));
    const { read } = await readFor(reads, id);
    void read.then(value => outcomes.push(value), error => outcomes.push(error));
  }
  const reason = new Error("client cancelled upload");
  for (const controller of controllers.values()) controller.abort(reason);
  await vi.waitFor(() => expect(outcomes).toEqual([reason, reason, reason, reason]), { timeout: 500 });
  requestUpload(client, "next");
  const { read } = await readFor(reads, "next");
  client.write(encodeBinaryFrame({ type: "binary", id: "next", event: "chunk", seq: 0, bytes: Buffer.from("valid") }));
  client.write(encodeBinaryFrame({ type: "binary", id: "next", event: "end", seq: 1, bytes: Buffer.alloc(0) }));
  await expect(read).resolves.toEqual(Buffer.from("valid"));
});

it("completed uploads detach their abort listener and pre-cancelled reads reject immediately", async () => {
  const active = new AbortController(), cancelled = new AbortController();
  const reason = new Error("cancelled before upload read");
  cancelled.abort(reason);
  const removed = vi.spyOn(active.signal, "removeEventListener");
  const { client, reads } = await startHarness(id => ({ signal: id === "complete" ? active.signal : cancelled.signal }));
  requestUpload(client, "complete");
  const { read: complete } = await readFor(reads, "complete");
  client.write(encodeBinaryFrame({ type: "binary", id: "complete", event: "chunk", seq: 0, bytes: Buffer.from("done") }));
  client.write(encodeBinaryFrame({ type: "binary", id: "complete", event: "end", seq: 1, bytes: Buffer.alloc(0) }));
  await expect(complete).resolves.toEqual(Buffer.from("done"));
  expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  requestUpload(client, "already-cancelled");
  const { read: rejected } = await readFor(reads, "already-cancelled");
  await expect(rejected).rejects.toBe(reason);
});

import { describe, expect, it } from "vitest";
import { streamResponseBody } from "../electron/proxy/streaming.js";

describe("stream response body", () => {
  it("flushes buffered UTF-8 decoder bytes before done", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xf0, 0x9f, 0x8c]));
          controller.close();
        },
      }),
    );

    const chunks = [];
    for await (const chunk of streamResponseBody(response)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: "delta", value: "\uFFFD" },
      { kind: "done" },
    ]);
  });
});

it("releases the response reader after normal completion", async () => {
  const response = new Response("hello");
  const chunks = [];
  for await (const chunk of streamResponseBody(response)) chunks.push(chunk);
  expect(chunks).toEqual([{kind: "delta", value: "hello"}, {kind: "done"}]);
  expect(response.body!.locked).toBe(false);
});

it("cancels unread bytes and releases the reader when the consumer stops", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
    cancel() { cancelled = true; },
  }));
  for await (const chunk of streamResponseBody(response)) {
    expect(chunk).toEqual({kind: "delta", value: "first"});
    break;
  }
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

it("releases a failed reader while retaining the existing error envelope", async () => {
  const response = new Response(new ReadableStream({start(c) { c.error(new Error("broken")); }}));
  const chunks = [];
  for await (const chunk of streamResponseBody(response)) chunks.push(chunk);
  expect(chunks).toEqual([{kind: "error", value: "broken"}]);
  expect(response.body!.locked).toBe(false);
});

it("cancellation settles a blocked read without awaiting the underlying cancel hook", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }));
  const iterator = streamResponseBody(response, abort.signal);
  const next = iterator.next();
  abort.abort(new Error("stop"));
  expect(await next).toEqual({done: false, value: {kind: "error", value: "stop"}});
  await iterator.return();
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

it("cleanup rejection cannot replace a successful early consumer return", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("first")); },
    cancel() { throw new Error("cancel failed"); },
  }));
  for await (const _chunk of streamResponseBody(response)) break;
  expect(response.body!.locked).toBe(false);
});

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

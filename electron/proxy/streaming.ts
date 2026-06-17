export type StreamChunk = {
  kind: "delta" | "done" | "error";
  value?: string;
};

export async function* streamResponseBody(response: Response): AsyncGenerator<StreamChunk> {
  if (!response.body) {
    yield { kind: "done" };
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          yield { kind: "delta", value: tail };
        }
        yield { kind: "done" };
        return;
      }
      const decoded = decoder.decode(value, { stream: true });
      if (decoded) {
        yield { kind: "delta", value: decoded };
      }
    }
  } catch (error) {
    yield { kind: "error", value: error instanceof Error ? error.message : String(error) };
  }
}

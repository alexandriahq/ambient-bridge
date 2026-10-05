export type StreamChunk = {
  kind: "delta" | "done" | "error";
  value?: string;
};

/** Cancellation is best-effort and must never replace the request outcome. */
export function discardResponseBody(response: Response | undefined): void {
  if (!response?.body || response.body.locked) return;
  try { void response.body.cancel().catch(() => {}); } catch { /* Already disposed. */ }
}

export async function* streamResponseBody(response: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  if (!response.body) {
    yield { kind: "done" };
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let ended = false;
  const cancel = () => {
    try { void reader.cancel(signal?.reason).catch(() => {}); } catch { /* Already disposed. */ }
  };
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (signal?.aborted) cancel();
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        ended = true;
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
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!ended) cancel();
    reader.releaseLock();
  }
}

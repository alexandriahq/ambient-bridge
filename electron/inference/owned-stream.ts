/** Keeps eagerly admitted work disposable even before the first iterator pull. */
export function ownedInferenceStream<T>(
  source: AsyncIterable<T>,
  controller: AbortController,
  release: (cancel: boolean) => void,
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let released = false;
  const dispose = (cancel: boolean) => {
    if (released) return;
    released = true;
    // Release before abort listeners can synchronously admit a replacement.
    release(cancel);
    if (cancel) controller.abort("consumer_closed");
  };
  return {
    [Symbol.asyncIterator]() { return this; },
    async next(...args) {
      try {
        const result = await iterator.next(...args);
        if (result.done) dispose(false);
        return result;
      } catch (error) {
        dispose(false);
        throw error;
      }
    },
    async return(value) {
      // Abort now; generator.return alone queues behind a pending reader.next.
      dispose(true);
      return iterator.return ? iterator.return(value) : { done: true, value };
    },
    async throw(error) {
      dispose(true);
      if (iterator.throw) return iterator.throw(error);
      throw error;
    },
  };
}

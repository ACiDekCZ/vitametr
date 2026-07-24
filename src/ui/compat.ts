/**
 * Small runtime browser-compat shims, installed once at app startup so every
 * part of the app (including lazily-loaded dependencies) can rely on them.
 */

/**
 * Safari/iOS does not implement async iteration of a ReadableStream
 * (`ReadableStream.prototype[Symbol.asyncIterator]`). Dependencies that do
 * `for await (… of stream)` — notably pdf.js `getTextContent` — otherwise fail
 * with "undefined is not a function (near '…value of readableStream…')". Install
 * a minimal, spec-shaped polyfill. Our own streaming code uses the manual
 * `getReader()/read()` loop, so this exists purely to keep bundled deps working
 * everywhere.
 */
function installReadableStreamAsyncIterator(): void {
  const proto: unknown =
    typeof ReadableStream !== 'undefined' ? ReadableStream.prototype : undefined;
  if (!proto || Symbol.asyncIterator in (proto as object)) return;
  async function* iterate(this: ReadableStream): AsyncGenerator<unknown> {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  Object.defineProperty(proto as object, Symbol.asyncIterator, {
    value: iterate,
    writable: true,
    configurable: true,
  });
  if (!('values' in (proto as object))) {
    Object.defineProperty(proto as object, 'values', {
      value: iterate,
      writable: true,
      configurable: true,
    });
  }
}

/** Install all runtime compat shims. Call once, as early as possible at boot. */
export function installBrowserCompat(): void {
  installReadableStreamAsyncIterator();
}

/** A non-empty body accepted by `new Response()` and `fetch()`. */
export type WebBody = NonNullable<ConstructorParameters<typeof Response>[0]>;

/**
 * Views bytes as a Fetch body without copying. Recent TypeScript libraries only accept
 * ArrayBuffer-backed views, so views over a SharedArrayBuffer are copied.
 */
export function bytesBody(bytes: Uint8Array): WebBody {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

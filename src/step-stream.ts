// A Workflow step's ordinary return value is capped at 1 MiB, but a step may
// instead return a ReadableStream<Uint8Array>, which is bounded only by the
// instance's total storage (1 GB on Workers Paid). The company boards' new
// postings go through this so that no burst of new roles, however large, can
// fail the run or be held back.

// Workflows requires each chunk to stay under 16 MB; 1 MiB leaves plenty of
// room.
export const STREAM_CHUNK_BYTES = 1024 * 1024;

export function jsonToStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  // A fresh stream on every call: Workflows rejects a locked or already-read
  // stream.
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + STREAM_CHUNK_BYTES));
      offset += STREAM_CHUNK_BYTES;
    },
  });
}

export async function streamToJson<T>(stream: ReadableStream<Uint8Array>): Promise<T> {
  return JSON.parse(await new Response(stream).text()) as T;
}

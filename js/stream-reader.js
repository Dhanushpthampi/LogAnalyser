import { APP_CONFIG } from './config.js';

/** Reads a File incrementally. No whole-file string or ArrayBuffer is created. */
export async function streamLines(file, onLines, onProgress, signal) {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let carry = '', processedBytes = 0, batch = [];
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      processedBytes += new TextEncoder().encode(value).byteLength;
      const text = carry + value;
      const parts = text.split(/\r?\n/);
      carry = parts.pop() ?? '';
      for (const line of parts) { batch.push(line); if (batch.length >= APP_CONFIG.ingestBatchSize) { await onLines(batch); batch = []; } }
      onProgress?.(processedBytes, file.size);
    }
    if (carry) batch.push(carry);
    if (batch.length) await onLines(batch);
  } finally { reader.releaseLock(); }
}

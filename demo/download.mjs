// Stream the response so progress reflects bytes received, not elapsed time.
export async function downloadBytes(response, onProgress, expectedSize = 0) {
  const length = expectedSize || Number(response.headers.get('content-length')) || 0;
  onProgress({loaded: 0, total: length});
  if (!response.body) throw new Error('Streaming downloads are not supported by this browser.');
  const reader = response.body.getReader();
  const buffer = length > 0 ? new Uint8Array(length) : null;
  const chunks = [];
  let loaded = 0, lastUpdate = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (buffer) {
        if (loaded + value.length > length) throw new Error('Checkpoint exceeds its expected size.');
        buffer.set(value, loaded);
      } else chunks.push(value);
      loaded += value.length;
      const now = performance.now();
      if (now - lastUpdate >= 100) { onProgress({loaded, total: length}); lastUpdate = now; }
    }
    if (length && loaded !== length) throw new Error('Checkpoint download was incomplete. Please retry.');
    onProgress({loaded, total: length || loaded});
    if (buffer) return buffer.buffer;
    return await new Blob(chunks).arrayBuffer();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

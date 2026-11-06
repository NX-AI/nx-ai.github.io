import {forecastLong, extractForecast} from './forecast-core.mjs';
import {downloadBytes} from './download.mjs';
const RUNTIME = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const MODEL = 'https://huggingface.co/NX-AI/TiRex-2/resolve/30788a311699acba7e6393ad9700ea7b7cb9bb2d/model.onnx';
let ort, session, resolveDownload;
const status = message => self.postMessage({type: 'status', message});
async function loadModel() {
  if (session) return true;
  let response, cache;
  try { cache = await caches.open('nxai-tirex2-onnx-v1'); response = await cache.match(MODEL); } catch {}
  if (!response) {
    const approved = await new Promise(resolve => {
      resolveDownload = resolve;
      self.postMessage({type:'confirm-download'});
    });
    if (!approved) return false;
  }
  status('Loading ONNX Runtime…');
  ort = await import(RUNTIME + 'ort.min.mjs');
  ort.env.wasm.wasmPaths = RUNTIME;
  // GitHub Pages has no cross-origin isolation: use one WASM thread in this worker.
  ort.env.wasm.numThreads = 1;
  let bytes;
  if (response) {
    status('Loading cached checkpoint…');
    bytes = await response.arrayBuffer();
  }
  else {
    status('Downloading checkpoint (407 MB)…');
    response = await fetch(MODEL);
    if (!response.ok) throw new Error(`Checkpoint download failed (${response.status}).`);
    // Size of the pinned checkpoint, also usable when Content-Length is hidden by CORS.
    bytes = await downloadBytes(response, progress => self.postMessage({type: 'progress', ...progress}), 406587026);
    if (cache) {
      status('Download complete. Caching checkpoint…');
      try { await cache.put(MODEL, new Response(bytes)); } catch {}
    }
  }
  status('Preparing model on your device…');
  session = await ort.InferenceSession.create(bytes, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
  return true;
}
self.onmessage = async ({data}) => {
  if (data.type === 'download-decision') {
    resolveDownload?.(data.approved === true);
    resolveDownload = null;
    return;
  }
  try {
    if (!await loadModel()) { self.postMessage({type:'cancelled'}); return; }
    status('Forecasting on your device… This may take a few minutes.');
    const start = performance.now();
    const forecast = await forecastLong(data.values, data.horizon, async (context, horizon) => {
    const inputs = {
      context: new ort.Tensor('float32', context, [1, context.length]),
      group_vector: new ort.Tensor('float32', Float32Array.of(1), [1]),
      target_mask: new ort.Tensor('bool', Uint8Array.of(1), [1]),
    };
    let output;
    try {
      output = await session.run(inputs);
      const tensor = output[session.outputNames[0]];
      return extractForecast(tensor.data, tensor.dims, horizon);
    } finally {
      Object.values(inputs).forEach(t => t.dispose());
      if (output) Object.values(output).forEach(t => t.dispose());
    }
    });
    self.postMessage({type: 'result', forecast, seconds: (performance.now() - start) / 1000});
  } catch (error) { self.postMessage({type: 'error', message: error.message || String(error)}); }
};

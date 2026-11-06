import {makeContext, extractForecast} from './forecast-core.mjs';
import {downloadBytes} from './download.mjs';
const RUNTIME = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const MODEL = 'https://huggingface.co/NX-AI/TiRex-2/resolve/30788a311699acba7e6393ad9700ea7b7cb9bb2d/model.onnx';
let ort, session;
const status = message => self.postMessage({type: 'status', message});
async function loadModel() {
  if (session) return;
  status('Loading ONNX Runtime…');
  ort = await import(RUNTIME + 'ort.min.mjs');
  ort.env.wasm.wasmPaths = RUNTIME;
  // GitHub Pages has no cross-origin isolation: use one WASM thread in this worker.
  ort.env.wasm.numThreads = 1;
  let response, cache;
  try { cache = await caches.open('nxai-tirex2-onnx-v1'); response = await cache.match(MODEL); } catch {}
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
}
self.onmessage = async ({data}) => {
  try {
    const context = makeContext(data.values);
    await loadModel();
    status('Forecasting on your device… This may take a few minutes.');
    const start = performance.now();
    const inputs = {
      context: new ort.Tensor('float32', context, [1, context.length]),
      group_vector: new ort.Tensor('float32', Float32Array.of(1), [1]),
      target_mask: new ort.Tensor('bool', Uint8Array.of(1), [1]),
    };
    let output;
    try {
      output = await session.run(inputs);
      const tensor = output[session.outputNames[0]];
      self.postMessage({type: 'result', forecast: extractForecast(tensor.data, tensor.dims, data.horizon),
        seconds: (performance.now() - start) / 1000});
    } finally {
      Object.values(inputs).forEach(t => t.dispose());
      if (output) Object.values(output).forEach(t => t.dispose());
    }
  } catch (error) { self.postMessage({type: 'error', message: error.message || String(error)}); }
};

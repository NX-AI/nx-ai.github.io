import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stageSite} from '../search/stage.mjs';

test('the site stages the demo runtime and search backends from the same locked package', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'nxai-runtime-'));
  try {
    fs.mkdirSync(path.join(output, 'search'));
    fs.writeFileSync(path.join(output, 'search/entries.json'), '[]\n');
    stageSite(output);
    const modules = new URL('../node_modules/', import.meta.url);
    const readPackage = name => JSON.parse(fs.readFileSync(new URL(`${name}/package.json`, modules)));
    assert.equal(readPackage('onnxruntime-web').version, readPackage('@huggingface/transformers').dependencies['onnxruntime-web']);
    for (const name of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm',
      'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
      assert.deepEqual(fs.readFileSync(path.join(output, 'search/runtime', name)),
        fs.readFileSync(new URL(`onnxruntime-web/dist/${name}`, modules)));
    }
  } finally {
    fs.rmSync(output, {recursive: true, force: true});
  }
});

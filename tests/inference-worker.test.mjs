import test from 'node:test';
import assert from 'node:assert/strict';

for (const cacheUnavailable of [false, true]) {
  test(`declining download prevents network access (cache unavailable: ${cacheUnavailable})`, async t => {
    const messages = [];
    let notify;
    const requested = new Promise(resolve => { notify = resolve; });
    const previousSelf = globalThis.self, previousCaches = globalThis.caches;
    globalThis.self = {postMessage(message) {
      messages.push(message.type);
      if (message.type === 'confirm-download') notify();
    }};
    globalThis.caches = {async open() {
      if (cacheUnavailable) throw new Error('Cache storage unavailable');
      return {async match() { return undefined; }};
    }};
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected download'); });
    try {
      await import(`../demo/inference-worker.mjs?cacheUnavailable=${cacheUnavailable}`);
      const running = self.onmessage({data: {values: [1], horizon: 1}});
      await requested;
      await self.onmessage({data: {type: 'download-decision', approved: false}});
      await running;
      assert.deepEqual(messages, ['confirm-download', 'cancelled']);
      assert.equal(fetch.mock.callCount(), 0);
    } finally {
      if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
      if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches;
    }
  });
}

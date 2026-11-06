import test from 'node:test';
import assert from 'node:assert/strict';
import {makeContext,extractForecast,selectSeries} from '../demo/forecast-core.mjs';
test('NaN padding and future prevent data leakage',()=>{
  const v=Array.from({length:96},(_,i)=>i);v[20]=null;
  assert.throws(()=>makeContext(Array(4).fill(null)));
  v.push(96);const x=makeContext(v);
  assert.equal(x.length,2368);assert(Number.isNaN(x[0]));
  assert.equal(x[2047],96);assert(Number.isNaN(x[2048]));
  assert(Number.isNaN(x[2048-v.length+20]));
});
test('long input keeps most recent 2048 steps',()=>{
  const x=makeContext(Array.from({length:3000},(_,i)=>i));
  assert.equal(x[0],952);assert.equal(x[2047],2999);
  assert(x.slice(2048).every(Number.isNaN));
});
test('output matches documented -352:-32 slice, not trailing patch',()=>{
  const width=2368, x=Float32Array.from({length:9*width},(_,i)=>i);
  const f=extractForecast(x,[1,9,width],96);
  assert.equal(f.low[0],2016);assert.equal(f.median[0],4*width+2016);
  assert.equal(f.high.at(-1),8*width+2016+95);assert.equal(f.median.length,96);
  assert.throws(()=>extractForecast(x,[1,9,width],321));
  assert.throws(()=>extractForecast(x,[9,width],96));
});
test('selecting history advances start without compressing gaps',()=>{
  const v=Array(2000).fill(7);v[1900]=null;
  const s=selectSeries({start:0,values:v},7);
  assert.equal(s.values.length,672);assert.equal(s.start,1328*900);
  assert.equal(s.values[572],null);assert.equal(s.start+s.values.length*900,2000*900);
});

import {downloadBytes} from '../demo/download.mjs';
test('download progress counts streamed bytes and uses known size without headers',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(Uint8Array.of(1,2));c.enqueue(Uint8Array.of(3,4));c.close();}});
  const progress=[];
  const result=await downloadBytes(new Response(stream),p=>progress.push(p),4);
  assert.deepEqual([...new Uint8Array(result)],[1,2,3,4]);
  assert.deepEqual(progress[0],{loaded:0,total:4});
  assert.deepEqual(progress.at(-1),{loaded:4,total:4});
});
test('incomplete checkpoint is rejected instead of reporting success',async()=>{
  await assert.rejects(()=>downloadBytes(new Response(Uint8Array.of(1,2)),()=>{},4),/incomplete/);
});
test('unknown download size still reports bytes and completes',async()=>{
  const progress=[];
  const result=await downloadBytes(new Response(Uint8Array.of(1,2,3)),p=>progress.push(p));
  assert.equal(result.byteLength,3);
  assert.deepEqual(progress[0],{loaded:0,total:0});
  assert.deepEqual(progress.at(-1),{loaded:3,total:3});
});

test('one-hour and 21-day context keep the same forecast cutoff',()=>{
  const series={start:0,values:Array.from({length:2048},(_,i)=>i)};
  for(const days of [1/24,7,21]){
    const selected=selectSeries(series,days);
    assert.equal(selected.values.length,days*96);
    assert.equal(selected.start+selected.values.length*900,2048*900);
    const context=makeContext(selected.values);
    assert.equal(context[2047],2047);
    assert(context.slice(2048).every(Number.isNaN));
  }
  assert.deepEqual(selectSeries(series,1/24).values,[2044,2045,2046,2047]);
  assert.throws(()=>selectSeries(series,0));
  assert.throws(()=>selectSeries(series,22));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { gzipSync } = require('node:zlib');
const root = path.join(__dirname, '..');
const kotlin = fs.readFileSync(path.join(root,
  'upstream/rear-card-bridge/app/src/main/java/dev/finall/rearcardbridge/packageio/LiveCarrierRuntime.kt'), 'utf8');
// Exercise the carrier's actual compatible Promise scheduler, not Node's microtasks.
const carrier = kotlin.split('private val SOURCE = """')[1].split('""".trimIndent()')[0]
  .replaceAll("${'$'}", '$').replaceAll('__CANVAS_NAME__', 'canvas')
  .replaceAll('__MODULE_ID__', 'test.endfield.scheduling');

function runtime(script, timedChunks = false) {
  const storage = new Map(), nativeFrames = [], dataListeners = [], pointerListeners = [];
  const records = [], network = [];
  let frameNumber = 0, lastBatch = null, clock = Date.now();
  // Each timing check advances the synthetic clock by 1 ms, so adaptive chunk
  // yielding is deterministic regardless of the desktop test runner's speed.
  class HostDate extends Date { static now() { return clock++; } }
  const canvas = {
    getContext: () => ({ setTransform() {}, clearRect() {} }),
    addEventListener: (type, fn) => { if (type === 'pointerup') pointerListeners.push(fn); },
    removeEventListener() {}
  };
  const context = vm.createContext({
    Date: timedChunks ? HostDate : Date,
    console: { log() {} },
    document: { getElementById: () => canvas },
    data: {
      bridge_live_payload: JSON.stringify({ revision: 1, script, snapshot: null, snapshotRev: 1 }),
      addEventListener: (type, fn) => { dataListeners.push(fn); }, removeEventListener() {}
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame(fn) { nativeFrames.push(fn); },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    record(label) { records.push({ frame: frameNumber, label }); }
  });
  context.window = context;
  vm.runInContext(carrier, context);
  function emit(path, value) {
    for (const listener of dataListeners) listener({ detail: { path, value } });
  }
  function frame(responseFor) {
    const callback = nativeFrames.shift();
    assert.equal(typeof callback, 'function', 'the carrier must keep scheduling native frames');
    frameNumber++;
    for (const pointer of pointerListeners) pointer({ pointerId: 1, clientX: 800, clientY: 550 });
    callback();
    const raw = storage.get('bridge_outbox');
    if (raw) {
      const batch = JSON.parse(raw);
      if (batch.batch !== lastBatch) {
        lastBatch = batch.batch;
        const results = {};
        for (const request of batch.requests) {
          assert.equal(request.op, 'net.request');
          network.push(request.args);
          results[request.id] = { ok: true, value: responseFor(request.args, network.length) };
        }
        emit('bridge_sync', JSON.stringify({ batch: batch.batch, results }));
      }
    }
  }
  return { context, records, network, frame, nativeFrames, get frameNumber() { return frameNumber; } };
}

test('the carrier drains resolved Promises in one frame; RAF resolutions yield to later frames', () => {
  const immediate = runtime(`
    var i=0;
    function work(){record('chunk');if(++i<5)Promise.resolve().then(work);}
    Promise.resolve().then(work);
  `);
  immediate.frame();
  assert.deepEqual(immediate.records.map(item => item.frame), [1, 1, 1, 1, 1]);
  const yielded = runtime(`
    var i=0;
    function work(){record('chunk');if(++i<5)new Promise(function(resolve){requestAnimationFrame(resolve);}).then(work);}
    Promise.resolve().then(work);
  `);
  for (let i = 0; i < 5; i++) yielded.frame();
  assert.deepEqual(yielded.records.map(item => item.frame), [1, 2, 3, 4, 5]);
  assert.equal(yielded.nativeFrames.length, 1);
});

test('six-megabyte compressed UTF-8 detail yields native frames for input and drawing before sync completes', async () => {
  const { compileScript } = await import(pathToFileURL(path.join(root,
    'upstream/rear-card-bridge/tools/card-build/src/compile.js')).href);
  const api = await compileScript(fs.readFileSync(path.join(root, 'src/shared/api.js'), 'utf8'), 'card/api.js');
  const crypto = ['core.js', 'sha256.js', 'md5.js', 'hmac.js']
    .map(name => fs.readFileSync(path.join(root, 'node_modules/crypto-js', name), 'utf8')).join('\n;\n');
  const { buildCardFflate } = await import(pathToFileURL(path.join(root, 'tools/card-payload.mjs')).href);
  const fflate = await buildCardFflate();
  const script = [crypto, fflate, `
    window.decodeChunkLengths=[];
    var decodePush=fflate.DecodeUTF8.prototype.push;
    fflate.DecodeUTF8.prototype.push=function(chunk,final){
      if(chunk.length){record('decode');window.decodeChunkLengths.push(chunk.length);}
      return decodePush.call(this,chunk,final);
    };
  `, api, `
    document.getElementById('canvas').addEventListener('pointerup', function(){record('input');});
    function drawProbe(){record('draw');if(!window.finished)requestAnimationFrame(drawProbe);}
    requestAnimationFrame(drawProbe);
    EndfieldAPI.create(bridge,{compressed:true}).fetchStamina(
      {accountToken:'synthetic-token',cred:'synthetic-cred',signToken:'synthetic-key',userId:'synthetic-user'},
      {id:'role:1',roleId:'synthetic-role',serverId:'1',name:'管理员#1234'}
    ).then(function(value){window.result=value;window.finished=true;record('done');},
      function(error){window.failure={code:error.code,message:error.message};window.finished=true;record('error');});
  `].join('\n;\n');
  const filler = '技能说明🛰️é:恢复理智\n';
  const detail = {
    dungeon: { curStamina: '123', maxStamina: '360' },
    base: { name: '阿·管理员🛰#1234' },
    chars: [{ charData: { id: 'char-1', name: '测试干员', illustrationUrl: 'https://example.com/art.png' }, level: 90 }],
    unusedDescription: filler.repeat(Math.ceil(6 * 1024 * 1024 / Buffer.byteLength(filler)))
  };
  const raw = Buffer.from(JSON.stringify({ code: 0, data: { detail } }));
  assert(raw.length > 6 * 1024 * 1024 && raw.length < 8 * 1024 * 1024);
  const response = { status: 200, headers: { 'content-encoding': ['gzip'] }, bodyBase64: gzipSync(raw).toString('base64') };
  assert(JSON.stringify(response).length < 200000);
  const host = runtime(script, true);
  let responseFrame;
  const respond = (args, count) => {
    if (count === 1) return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data: { token: 'synthetic-new-key' } }) };
    assert.equal(count, 2, 'large detail must not be retried');
    assert.equal(args.responseType, 'base64');
    responseFrame = host.frameNumber;
    return response;
  };
  for (let i = 0; i < 2000 && !host.context.finished; i++) host.frame(respond);
  assert.equal(host.context.failure, undefined, JSON.stringify(host.context.failure));
  assert.equal(host.context.finished, true, 'sync finishes without requiring native Promise microtasks');
  assert.equal(host.context.result.stamina.current, 123);
  assert.equal(host.context.result.profile.name, '阿·管理员🛰#1234');
  assert.equal(host.context.result.dashboard.operators[0].name, '测试干员');
  const completedAt = host.records.find(item => item.label === 'done').frame;
  assert(completedAt > responseFrame + 2, 'large decode must span several native frames');
  assert(Math.max(...host.context.decodeChunkLengths) <= 8192, 'UTF-8 conversion must never receive one large output chunk');
  const decodeFrames = host.records.filter(item => item.label === 'decode').map(item => item.frame);
  assert(new Set(decodeFrames).size > 2, 'UTF-8 work itself is split across native frames');
  const firstDecode = Math.min(...decodeFrames), lastDecode = Math.max(...decodeFrames);
  assert(host.records.some(item => item.label === 'draw' && item.frame >= firstDecode && item.frame < lastDecode),
    'rendering progresses while UTF-8 work is still incomplete');
  assert(host.records.some(item => item.label === 'input' && item.frame > firstDecode && item.frame <= lastDecode),
    'input progresses while UTF-8 work is still incomplete');
  const duringDecode = host.records.filter(item => item.frame > responseFrame && item.frame < completedAt);
  assert(duringDecode.some(item => item.label === 'input'), 'input is handled between decode chunks');
  assert(duringDecode.some(item => item.label === 'draw'), 'drawing is dispatched between decode chunks');
  assert.equal(host.network.length, 2);
  assert.equal(host.nativeFrames.length, 1, 'native frame loop survives the complete synchronization');
});

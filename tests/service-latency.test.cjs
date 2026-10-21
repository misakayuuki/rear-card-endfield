'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));

function seedStored(storage, key, value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 150000) { storage.set(key, value); return; }
  const pointer = { endfieldChunked: 1, revision: 'fixture', parts: 0, length: serialized.length };
  for (let offset = 0; offset < serialized.length;) {
    let size = Math.min(150000, serialized.length - offset), part = serialized.slice(offset, offset + size);
    while (JSON.stringify(part).length > 150000) {
      size = Math.floor(size * 0.8); part = serialized.slice(offset, offset + size);
    }
    storage.set(key + '.chunk.fixture.' + pointer.parts++, part);
    offset += size;
  }
  storage.set(key, pointer);
}

function latencyHost() {
  const start = 1000000;
  let now = start, timerSequence = 0, queue = [], nativeValue, nativeReads = 0, hydrateCalls = 0;
  const apiOptions=[];
  const timers = new Map(), storage = new Map(), batches = [], publications = [];
  const role = { id: 'role:1', roleId: 'fixture-role', serverId: '1', name: '测试玩家#1234', server: '国服' };
  const config = { sessionRevision: 'fixture-session', role, settings: {} };
  const portrait = { dataUrl: 'data:image/webp;base64,' + 'A'.repeat(479960) };
  const dashboard = { operators: [{id:'saved-operator',level:20,weapon:{name:'上次武器',level:15},
    equipment:[{name:'上次装备',level:10}]}], glory: { displayKnown: true, displayCount: 10,
    medals: Array.from({ length: 10 }, (_, index) => ({ id: 'medal-' + index, name: '蚀刻章',
      iconDataUrl: 'data:image/png;base64,' + 'B'.repeat(23900) })) } };
  const result = current => ({ stamina: { current, max: 360, updatedAt: now },
    profile: { name: '本次接口#1234', level: 60 },
    dashboard:{operators:[{id:'changed-operator',level:90,weapon:{level:90}}],glory:{medals:[]}},
    characters: [{id:'new-art',url:'https://example.com/new-art.png'}] });
  const original = { schemaVersion: 1, sessionRevision: config.sessionRevision, settings: {},
    ...result(80), profile: { name: role.name, level: 30 }, dashboard, portrait,
    syncedAt: now, detailsSyncedAt: now-5000, error: null };
  storage.set('endfield.auth', { cred: 'synthetic-credential', sessionRevision: config.sessionRevision });
  seedStored(storage, 'endfield.snapshot', original);
  seedStored(storage, 'endfield.portrait', portrait);
  function invoke(op, key, value) {
    return new Promise((resolve, reject) => queue.push({ op, key, value, resolve, reject }));
  }
  const bridge = {
    log: { info: message => invoke('log.info', message) },
    config: { get: key => invoke('config.get', key), set: (key, value) => invoke('config.set', key, value) },
    storage: { get: key => invoke('storage.get', key), set: (key, value) => invoke('storage.set', key, value),
      remove: key => invoke('storage.remove', key) },
    net: { request: args => invoke('net.request', args.url) },
    card: {
      readSnapshot() { nativeReads++; return nativeValue; },
      saveSnapshot: value => invoke('card.saveSnapshot', undefined, value),
      requestRefresh: () => invoke('card.requestRefresh')
    }
  };
  class HostDate extends Date { static now() { return now; } }
  const sandbox = { Date: HostDate, Math, Number, Promise,
    setTimeout(fn, milliseconds) { const id = ++timerSequence; timers.set(id, { fn, at: now + milliseconds }); return id; },
    clearTimeout: id => timers.delete(id),
    EndfieldAPI: { create: (_bridge,options) => {apiOptions.push(options);return { fetchStamina: async () => {
      await bridge.net.request({ url: 'synthetic:refresh-auth' });
      await bridge.net.request({ url: 'synthetic:detail' });
      return result(95);
    } };} },
    EndfieldMedia: { hydrate: async value => {hydrateCalls++;return value;} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ['core', 'cache', 'service']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/shared', name + '.js'), 'utf8'), sandbox);
  }
  nativeValue = sandbox.EndfieldCache.pack(original);
  const service = sandbox.EndfieldService.create(bridge, { card: true });
  async function drive(task, beforeBatch) {
    let settled = false, value, failure;
    task.then(result => { value = result; settled = true; }, error => { failure = error; settled = true; });
    for (let tick = 0; tick < 120 && !settled; tick++) {
      await flush();
      if (settled) break;
      assert(queue.length > 0 || timers.size > 0, 'operation must still have work to complete');
      const calls = queue; queue = [];
      now += 1000;
      batches.push({ at: now - start, calls: calls.map(call => ({ op: call.op, key: call.key })) });
      if (beforeBatch) beforeBatch(calls);
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      const replies = [];
      for (const call of calls) {
        let reply = null;
        if (call.op === 'config.get') reply = call.key === undefined ? { ...config } : config[call.key] ?? null;
        else if (call.op === 'config.set') config[call.key] = call.value;
        else if (call.op === 'storage.get') reply = storage.get(call.key) ?? null;
        else if (call.op === 'storage.set') {
          assert(JSON.stringify(call.value).length <= 256 * 1024);
          storage.set(call.key, call.value);
        } else if (call.op === 'storage.remove') storage.delete(call.key);
        else if (call.op === 'card.saveSnapshot') {
          nativeValue = call.value;
          publications.push(sandbox.EndfieldCache.unpack(call.value));
        }
        replies.push(reply);
        call.resolve(reply);
      }
      assert(JSON.stringify(replies).length <= 200000, 'a reply batch must stay below the rear HostVar budget');
    }
    await flush();
    assert(settled, 'operation must settle within the simulated time budget');
    if (failure) throw failure;
    return value;
  }
  function readCommitted() {
    const value = storage.get('endfield.snapshot');
    if (!value || value.endfieldChunked !== 1) return value;
    const parts = [];
    for (let i = 0; i < value.parts; i++) parts.push(storage.get('endfield.snapshot.chunk.' + value.revision + '.' + i));
    return JSON.parse(parts.join(''));
  }
  return { service, drive, storage, config, original, portrait, dashboard, batches, publications, timers, readCommitted, apiOptions,
    get nativeReads() { return nativeReads; }, get elapsed() { return now - start; },
    get hydrateCalls() { return hydrateCalls; },
    replaceAccount() {
      config.sessionRevision = 'replacement-session';
      config.role = { ...role, id: 'role:2', roleId: 'replacement-role', name: '新玩家#5678' };
      const replacement = { ...original, sessionRevision: config.sessionRevision,
        stamina: { current: 222, max: 360, updatedAt: now }, profile: { name: config.role.name }, syncedAt: now };
      seedStored(storage, 'endfield.snapshot', replacement);
      nativeValue = sandbox.EndfieldCache.pack(replacement);
      storage.set('endfield.auth', { cred: 'replacement-synthetic-credential', sessionRevision: config.sessionRevision });
    }
  };
}

test('stamina-only card refresh with large cached details and concurrent reloads finishes within 40 seconds', async t => {
  const host = latencyHost();
  assert(JSON.stringify(host.original).length > 719000);
  const refresh = host.service.refresh();
  // Startup reload and a config/refresh notification may overlap a manual tap.
  const reloads = [0, 1].map(() => host.service.getSnapshot().then(() => host.service.getSettings()));
  const values = await host.drive(Promise.all([refresh, ...reloads]));
  t.diagnostic('Stamina refresh plus two reloads: ' + host.batches.length + ' one-second bridge batches.');
  assert.equal(values[0].stamina.current, 95);
  assert(host.elapsed < 40000, 'the complete publication must finish before the service deadline');
  assert(host.nativeReads > 0, 'reuse the already-delivered native snapshot');
  const calls = host.batches.flatMap(batch => batch.calls);
  assert(calls.some(call => call.op === 'log.info' && call.key === 'endfield.sync.begin'));
  assert(calls.some(call => call.op === 'log.info' && call.key === 'endfield.sync.display.save'));
  for (const call of calls.filter(call => call.op === 'log.info')) {
    assert.match(call.key, /^endfield\.sync\.(begin|account\.ready|data\.ready|cache\.write|display\.save|display\.ready|done)$/);
  }
  assert(calls.some(call => call.op === 'config.get' && call.key === undefined), 'session and role share one small config response');
  assert(!calls.some(call => call.op === 'storage.get' && /\.chunk\./.test(call.key)),
    'unchanged high-resolution artwork must not cross the bridge again');
  assert(!calls.some(call=>call.key==='endfield.characters'),'stamina sync never refreshes portrait candidates');
  assert.equal(host.hydrateCalls,0);
  assert.equal(host.apiOptions[0].staminaOnly,true);
  assert(calls.some(call => call.op === 'card.requestRefresh'));
  const stored = host.readCommitted();
  assert.equal(stored.stamina.current, 95);
  assert.equal(stored.sessionRevision, 'fixture-session');
  assert.equal(stored.portrait.dataUrl, host.portrait.dataUrl);
  assert.equal(stored.dashboard.glory.medals.length, 10);
  assert.equal(stored.dashboard.glory.medals[9].iconDataUrl, host.dashboard.glory.medals[9].iconDataUrl);
  assert.deepEqual(stored.dashboard,host.original.dashboard);
  assert.deepEqual(stored.profile,host.original.profile);
  assert.equal(stored.detailsSyncedAt,host.original.detailsSyncedAt);
  assert.equal(host.publications.at(-1).stamina.current, 95);
  assert.equal(host.publications.at(-1).portrait.dataUrl, host.portrait.dataUrl);
  assert.equal(host.timers.size, 0);
});

test('a session change during delayed network replies cannot publish the previous account', async () => {
  const host = latencyHost();
  let replaced = false;
  await host.drive(host.service.refresh(), calls => {
    if (!replaced && calls.some(call => call.op === 'net.request' && call.key === 'synthetic:detail')) {
      replaced = true;
      host.replaceAccount();
    }
  });
  assert(replaced);
  assert.equal(host.publications.length, 0, 'an obsolete response must never overwrite the new native snapshot');
  assert.equal(host.readCommitted().sessionRevision, 'replacement-session');
  assert.equal(host.readCommitted().stamina.current, 222);
  assert.equal(host.readCommitted().profile.name, '新玩家#5678');
  assert.equal(host.timers.size, 0);
});

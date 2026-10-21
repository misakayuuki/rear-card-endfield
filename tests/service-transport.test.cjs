'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const coreSource = fs.readFileSync(path.join(root, 'src/shared/core.js'), 'utf8');
const cacheSource = fs.readFileSync(path.join(root, 'src/shared/cache.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src/shared/service.js'), 'utf8');
const role = { id: 'sample:1', roleId: 'sample', serverId: '1', name: '示例玩家#1234', server: '国服' };
const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await pause();
  }
  assert.fail('expected asynchronous step did not occur');
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function seedValue(storage, key, value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 140000) { storage.set(key, value); return; }
  const parts = Math.ceil(serialized.length / 140000);
  const pointer = { endfieldChunked: 1, revision: 'fixture', parts, length: serialized.length };
  storage.set(key, pointer);
  for (let i = 0; i < parts; i++) storage.set(key + '.chunk.fixture.' + i, serialized.slice(i * 140000, (i + 1) * 140000));
}
function data(current, timestamp, dashboard = null) {
  return { stamina: { current, max: 360, updatedAt: timestamp }, profile: { name: role.name }, dashboard, characters: [] };
}
function harness(options = {}) {
  const storage = new Map();
  const config = new Map([['sessionRevision', 'test-session'], ['role', role]]);
  storage.set('endfield.auth', { cred: 'fixture-only', sessionRevision: 'test-session' });
  const snapshots = [], nativeSnapshots = [], apiOptions = [];
  const timers = new Map();
  const batches = [];
  const calls = [];
  let nativeSnapshot = null;
  let nextTimer = 0, queued = [], flushScheduled = false;
  let fetchImpl = async () => data(90, 2000);
  let hangRead = null;
  let fetchCalls = 0, hydrateCalls = 0;
  function get(key) {
    calls.push({op:'get',key});
    if (hangRead && hangRead(key)) return new Promise(() => {});
    return new Promise((resolve, reject) => {
      queued.push({ key, resolve, reject });
      if (flushScheduled) return;
      flushScheduled = true;
      setImmediate(() => {
        flushScheduled = false;
        const current = queued;
        queued = [];
        const results = current.map(entry => storage.get(entry.key) ?? null);
        const wireChars = JSON.stringify({ batch: 'fixture', results }).length;
        batches.push({ count: current.length, wireChars });
        if (wireChars > 200000) {
          for (const item of current) item.reject(new Error('HostVar result batch exceeded 200K'));
        } else current.forEach((item, i) => item.resolve(results[i]));
      });
    });
  }
  const bridge = {
    storage: { get,
      set: async (key, value) => { calls.push({op:'set',key}); assert(JSON.stringify(value).length <= 256 * 1024); storage.set(key, value); },
      remove: async key => { calls.push({op:'remove',key}); return storage.delete(key); } },
    config: { get: async key => key === undefined ? Object.fromEntries(config) : config.get(key) ?? null,
      set: async (key, value) => config.set(key, value) },
    card: { saveSnapshot: async value => {
      const wire=JSON.stringify({batch:'batch-fixture',module:'dev.endfield.rearcard',acks:[],requests:[{id:'request-fixture',op:'card.saveSnapshot',args:{value}}]});
      assert(wire.length*2+16384<1024*1024,'native snapshot request fits Binder including UTF-16 and overhead');
      nativeSnapshots.push(JSON.parse(JSON.stringify(value)));
      nativeSnapshot=nativeSnapshots.at(-1);
      snapshots.push(sandbox.EndfieldCache.unpack(nativeSnapshots.at(-1)));
    }, requestRefresh: async () => {} }
  };
  if (options.native) bridge.card.readSnapshot=()=>nativeSnapshot;
  const sandbox = { console, Date, Math, Number, Promise,
    setTimeout: (fn, milliseconds) => { const id = ++nextTimer; timers.set(id, { fn, milliseconds }); return id; },
    clearTimeout: id => timers.delete(id),
    EndfieldAPI: { create: (_bridge, options) => {
      apiOptions.push(options);
      return { fetchStamina: (...args) => { fetchCalls++; return fetchImpl(...args); } };
    } },
    EndfieldMedia: { hydrate: async dashboard => { hydrateCalls++; return dashboard; } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(cacheSource, sandbox);
  vm.runInContext(serviceSource, sandbox);
  const service = sandbox.EndfieldService.create(bridge, { card: true });
  return { service, bridge, storage, config, snapshots, nativeSnapshots, batches, timers, calls, apiOptions,
    createOtherView: options => sandbox.EndfieldService.create(bridge, options),
    set native(value) { nativeSnapshot=value; },
    set fetch(value) { fetchImpl = value; }, set hangRead(value) { hangRead = value; },
    get fetchCalls() { return fetchCalls; },
    get hydrateCalls() { return hydrateCalls; },
    fire(milliseconds) {
      const entry = [...timers.entries()].find(([, timer]) => timer.milliseconds === milliseconds);
      assert(entry, 'expected pending ' + milliseconds + 'ms timer');
      timers.delete(entry[0]); entry[1].fn();
    },
    seed(current, portrait = null, dashboard = null, fields = {}) {
      const value = { schemaVersion: 1, sessionRevision: 'test-session', settings: {},
        ...data(current, 1000, dashboard), portrait, syncedAt: 1000, detailsSyncedAt: 750, error: null, ...fields };
      seedValue(storage, 'endfield.snapshot', value);
      if (portrait) seedValue(storage, 'endfield.portrait', portrait);
      if (options.native) nativeSnapshot=sandbox.EndfieldCache.pack(value);
      return value;
    }
  };
}

test('concurrent card reload and refresh keep all large storage reply batches below 200K', async () => {
  const h = harness();
  const portrait = { dataUrl: 'data:image/webp;base64,' + 'A'.repeat(450000) };
  const icon = 'data:image/png;base64,' + 'B'.repeat(20000);
  const dashboard = { glory: { displayKnown: true, displayCount: 10,
    medals: Array.from({ length: 10 }, (_, i) => ({ id: 'medal-' + i, name: '示例章', iconDataUrl: icon })) }, operators: [] };
  h.seed(80, portrait, dashboard);
  h.fetch = async () => data(95, 2000, dashboard);
  const results = await Promise.all([h.service.getSnapshot(), h.service.getSnapshot(), h.service.refresh()]);
  assert(results.every(value => value.portrait.dataUrl === portrait.dataUrl));
  assert.equal(results[2].stamina.current, 95);
  assert.equal(results[2].dashboard.glory.medals.length, 10);
  assert(JSON.stringify(results[2]).length > 650000, 'fixture exercises realistic high-resolution payloads');
  assert(h.batches.every(batch => batch.wireChars <= 200000));
  assert(h.batches.every(batch => batch.count === 1), 'parallel readers cannot share a native reply batch');
  assert.equal(h.fetchCalls, 1);
  assert.equal(h.nativeSnapshots.at(-1).endfieldPackedSnapshot,1);
  assert.equal(h.snapshots.at(-1).portrait.dataUrl,portrait.dataUrl);
  assert.equal(h.snapshots.at(-1).stamina.current,95);
  assert.equal(h.timers.size, 0, 'completed operations release all timeout timers');
});

test('card refresh changes only stamina and preserves profile, showcase, equipment and their sync time', async () => {
  const h=harness({native:true});
  const portrait={dataUrl:'data:image/webp;base64,'+'A'.repeat(450000)};
  const oldProfile={name:'上次资料#1234',level:30,server:'国服'};
  const oldDashboard={glory:{displayKnown:true,medals:[{id:'old',name:'旧展示章',iconDataUrl:'data:image/png;base64,AAAA'}]},
    operators:[{id:'c1',level:20,weapon:{name:'旧武器',level:10},equipment:[{name:'旧装备',level:15}]}]};
  h.seed(80,portrait,oldDashboard,{profile:oldProfile});
  const dashboard={glory:{displayKnown:true,medals:[{id:'new',name:'新展示章'}]},
    operators:[{id:'c1',level:90,weapon:{name:'新武器',level:90},equipment:[{name:'新装备',level:90}]}]};
  h.fetch=async()=>({...data(120,3000,dashboard),profile:{name:'本次接口#1234',level:60,server:'新服务器'},
    characters:[{id:'unused',url:'https://example.com/art.png'}]});
  const value=await h.service.refresh();
  assert.equal(value.stamina.current,120);
  assert.equal(value.syncedAt,3000);
  assert.deepEqual(JSON.parse(JSON.stringify(value.profile)),oldProfile);
  assert.deepEqual(JSON.parse(JSON.stringify(value.dashboard)),oldDashboard);
  assert.equal(value.detailsSyncedAt,750);
  assert.equal(value.portrait.dataUrl,portrait.dataUrl);
  assert.equal(h.hydrateCalls,0,'stamina sync must not inspect or download showcase images');
  assert.equal(h.apiOptions[0].staminaOnly,true);
  assert(!h.calls.some(call=>call.key.startsWith('endfield.portrait')),'rear sync never reads, writes or removes portrait storage');
  assert(!h.calls.some(call=>call.key==='endfield.characters'),'rear sync does not update portrait candidates');
  assert(!h.calls.some(call=>call.op==='get'&&call.key.startsWith('endfield.snapshot.chunk.')),'native pictures do not cross the results bridge again');
  const otherView=await h.createOtherView().getSnapshot();
  assert.equal(otherView.stamina.current,120,'settings and background can read the same committed business cache');
  assert.equal(otherView.portrait.dataUrl,portrait.dataUrl);
  assert.deepEqual(JSON.parse(JSON.stringify(otherView.profile)),oldProfile);
  assert.deepEqual(JSON.parse(JSON.stringify(otherView.dashboard)),oldDashboard);
  assert.equal(otherView.detailsSyncedAt,750);
});

test('manual settings sync updates full details and later card and background stamina syncs preserve them', async () => {
  const h=harness({native:true});
  const portrait={dataUrl:'data:image/webp;base64,'+'A'.repeat(170000)};
  h.seed(80,portrait,{glory:{medals:[{id:'old'}]},operators:[{id:'c1',level:20}]});
  const settings=h.createOtherView();
  const profile={name:'手动更新#1234',level:60,server:'国服'};
  const dashboard={glory:{displayKnown:true,medals:[{id:'manual',name:'手动展示章',iconDataUrl:'data:image/png;base64,BBBB'}]},
    operators:[{id:'c1',level:90,weapon:{name:'手动武器',level:90},equipment:[{name:'手动装备',level:70}]}]};
  const characters=[{id:'manual',url:'https://example.com/manual.png'}];
  h.fetch=async()=>({...data(120,3000,dashboard),profile,characters});
  const manual=await settings.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(manual.profile)),profile);
  assert.deepEqual(JSON.parse(JSON.stringify(manual.dashboard)),dashboard);
  assert.equal(manual.detailsSyncedAt,3000);
  assert.equal(h.hydrateCalls,1);
  assert.deepEqual(h.storage.get('endfield.characters'),characters);
  assert.equal(h.apiOptions[1].staminaOnly,false);

  const background=h.createOtherView({staminaOnly:true});
  for(const [service,current,timestamp] of [[h.service,130,4000],[background,140,5000]]){
    const callStart=h.calls.length;
    h.fetch=async()=>({...data(current,timestamp,{glory:{medals:[]},operators:[]}),
      profile:{name:'不得覆盖',level:1},characters:[]});
    const updated=await service.refresh();
    assert.equal(updated.stamina.current,current);
    assert.equal(updated.syncedAt,timestamp);
    assert.deepEqual(JSON.parse(JSON.stringify(updated.profile)),profile);
    assert.deepEqual(JSON.parse(JSON.stringify(updated.dashboard)),dashboard);
    assert.equal(updated.detailsSyncedAt,3000);
    assert.equal(updated.portrait.dataUrl,portrait.dataUrl);
    assert.equal(h.hydrateCalls,1,'only the manual settings refresh hydrates media');
    assert(!h.calls.slice(callStart).some(call=>call.op==='set'&&call.key==='endfield.characters'));
    assert.deepEqual(h.storage.get('endfield.characters'),characters);
  }
  assert.equal(h.apiOptions[2].staminaOnly,true);
  assert.equal(h.apiOptions[2].compressed,false,'background uses its WebView transport');
  const committed=await settings.getSnapshot();
  assert.equal(committed.stamina.current,140);
  assert.deepEqual(JSON.parse(JSON.stringify(committed.dashboard)),dashboard);
  assert.equal(committed.detailsSyncedAt,3000);
});

test('a card request in flight preserves a manual detail update completed before its reply', async () => {
  const h=harness({native:true});
  h.seed(80,null,{glory:{medals:[{id:'old'}]},operators:[{id:'c1',level:20}]});
  const delayed=deferred();
  h.fetch=()=>delayed.promise;
  const refreshing=h.service.refresh();
  await until(()=>h.fetchCalls===1);
  const profile={name:'最新资料#1234',level:60};
  const dashboard={glory:{medals:[{id:'fresh'}]},operators:[{id:'c1',level:90,weapon:{level:90}}]};
  h.fetch=async()=>({...data(100,3000,dashboard),profile});
  await h.createOtherView().refresh();
  delayed.resolve({...data(150,4000,{glory:{medals:[{id:'stale'}]},operators:[]}),profile:{name:'旧请求资料'}});
  const final=await refreshing;
  assert.equal(final.stamina.current,150);
  assert.deepEqual(JSON.parse(JSON.stringify(final.profile)),profile);
  assert.deepEqual(JSON.parse(JSON.stringify(final.dashboard)),dashboard);
  assert.equal(final.detailsSyncedAt,3000);
  assert.equal(h.hydrateCalls,1);
});

test('manual full sync updates newer details even when a later stamina-only response already committed', async () => {
  const h=harness({native:true});
  h.seed(80,null,{glory:{medals:[{id:'old'}]},operators:[]});
  const delayed=deferred();
  h.fetch=()=>delayed.promise;
  const manual=h.createOtherView().refresh();
  await until(()=>h.fetchCalls===1);
  h.fetch=async()=>data(150,5000);
  await h.service.refresh();
  const profile={name:'手动更新#1234',level:60};
  const dashboard={glory:{medals:[{id:'manual'}]},operators:[{id:'c1',level:90}]};
  delayed.resolve({...data(120,3000,dashboard),profile});
  const value=await manual;
  assert.equal(value.stamina.current,150,'keep the newer stamina response');
  assert.equal(value.syncedAt,5000);
  assert.equal(value.detailsSyncedAt,3000,'full data has its own freshness clock');
  assert.deepEqual(JSON.parse(JSON.stringify(value.profile)),profile);
  assert.deepEqual(JSON.parse(JSON.stringify(value.dashboard)),dashboard);
  const committed=await h.createOtherView().getSnapshot();
  assert.equal(committed.detailsSyncedAt,3000);
  assert.deepEqual(JSON.parse(JSON.stringify(committed.dashboard)),dashboard);
});

test('failure publication preserves concurrently updated details with the same stamina timestamp', async () => {
  const h=harness({native:true});
  h.seed(80,null,{glory:{medals:[{id:'old'}]},operators:[]});
  const held=deferred(); let waiting=false,hold=true;
  const originalGet=h.bridge.config.get;
  h.bridge.config.get=async key=>{
    if(key==='settings'&&hold){hold=false;waiting=true;await held.promise;}
    return originalGet(key);
  };
  h.fetch=async()=>{throw new Error('fixture network failure');};
  const failed=assert.rejects(h.service.refresh(),/fixture network failure/);
  await until(()=>waiting);
  const profile={name:'新的资料#1234',level:60};
  const dashboard={glory:{medals:[{id:'fresh'}]},operators:[{id:'c1',level:90}]};
  h.fetch=async()=>({...data(80,1000,dashboard),profile});
  await h.createOtherView().refresh();
  held.resolve();
  await failed;
  const value=await h.service.getSnapshot();
  assert.equal(value.stamina.updatedAt,1000);
  assert.equal(value.detailsSyncedAt,1000);
  assert.deepEqual(JSON.parse(JSON.stringify(value.profile)),profile);
  assert.deepEqual(JSON.parse(JSON.stringify(value.dashboard)),dashboard);
  assert.equal(value.error,'同步失败，请在设置页检查登录');
});

test('manual details committed during card chunk writes survive the later card publication', async () => {
  const h=harness({native:true});
  const portrait={dataUrl:'data:image/webp;base64,'+'A'.repeat(200000)};
  h.seed(80,portrait,{glory:{medals:[{id:'old'}]},operators:[]});
  const held=deferred(); let waiting=false,hold=true;
  const originalSet=h.bridge.storage.set;
  h.bridge.storage.set=async(key,value)=>{
    if(hold&&key.startsWith('endfield.snapshot.chunk.')){hold=false;waiting=true;await held.promise;}
    return originalSet(key,value);
  };
  h.fetch=async()=>data(150,4000);
  const refreshing=h.service.refresh();
  await until(()=>waiting);
  const profile={name:'并发更新#1234',level:60};
  const dashboard={glory:{medals:[{id:'manual'}]},operators:[{id:'c1',level:90}]};
  h.fetch=async()=>({...data(120,3000,dashboard),profile});
  await h.createOtherView().refresh();
  held.resolve();
  const value=await refreshing;
  assert.equal(value.stamina.current,150);
  assert.equal(value.syncedAt,4000);
  assert.equal(value.detailsSyncedAt,3000);
  assert.deepEqual(JSON.parse(JSON.stringify(value.profile)),profile);
  assert.deepEqual(JSON.parse(JSON.stringify(value.dashboard)),dashboard);
  const stored=await h.createOtherView().getSnapshot();
  const native=h.snapshots.at(-1);
  for(const committed of [stored,native]){
    assert.equal(committed.detailsSyncedAt,3000);
    assert.deepEqual(JSON.parse(JSON.stringify(committed.dashboard)),dashboard);
    assert.equal(committed.portrait.dataUrl,portrait.dataUrl);
  }
});

test('manual details committed during background chunk writes remain in storage and on the display', async () => {
  const h=harness({native:true});
  const portrait={dataUrl:'data:image/webp;base64,'+'A'.repeat(200000)};
  h.seed(80,portrait,{glory:{medals:[{id:'old'}]},operators:[]});
  const held=deferred(); let waiting=false,hold=true;
  const originalSet=h.bridge.storage.set;
  h.bridge.storage.set=async(key,value)=>{
    if(hold&&key.startsWith('endfield.snapshot.chunk.')){hold=false;waiting=true;await held.promise;}
    return originalSet(key,value);
  };
  h.fetch=async()=>data(150,4000);
  const refreshing=h.createOtherView({staminaOnly:true}).refresh();
  await until(()=>waiting);
  const profile={name:'手动资料#1234',level:60};
  const dashboard={glory:{medals:[{id:'manual'}]},operators:[{id:'c1',level:90}]};
  h.fetch=async()=>({...data(120,3000,dashboard),profile});
  await h.createOtherView().refresh();
  held.resolve();
  const value=await refreshing;
  const stored=await h.createOtherView().getSnapshot();
  const native=h.snapshots.at(-1);
  for(const committed of [value,stored,native]){
    assert.equal(committed.detailsSyncedAt,3000);
    assert.deepEqual(JSON.parse(JSON.stringify(committed.profile)),profile);
    assert.deepEqual(JSON.parse(JSON.stringify(committed.dashboard)),dashboard);
    assert.equal(committed.portrait.dataUrl,portrait.dataUrl);
  }
});

test('legacy snapshots without a separate detail timestamp retain their last full sync time', async () => {
  for(const mode of ['card','background']){
    const h=harness({native:true});
    h.seed(80,null,{glory:{medals:[{id:'legacy'}]},operators:[]},{detailsSyncedAt:undefined});
    const service=mode==='card'?h.service:h.createOtherView({staminaOnly:true});
    const value=await service.refresh();
    assert.equal(value.stamina.current,90);
    assert.equal(value.detailsSyncedAt,1000);
    assert.equal(value.dashboard.glory.medals[0].id,'legacy');
    assert.equal(h.hydrateCalls,0);
  }
});

test('missing or stale native snapshots fall back to business snapshot without separate portrait reads', async () => {
  for(const stale of [false,true]){
    const h=harness({native:true});
    const portrait={dataUrl:'data:image/png;base64,'+'B'.repeat(170000)};
    const cached=h.seed(80,portrait);
    h.native=stale?{...cached,sessionRevision:'old-session',portrait:{dataUrl:'data:image/png;base64,OLD'}}:null;
    const value=await h.service.refresh();
    assert.equal(value.stamina.current,90);
    assert.equal(value.portrait.dataUrl,portrait.dataUrl);
    assert(h.calls.some(call=>call.op==='get'&&call.key.startsWith('endfield.snapshot.chunk.')));
    assert(!h.calls.some(call=>call.key.startsWith('endfield.portrait')));
  }
});

test('a card native save completing after another view logs out repairs the shared snapshot', async () => {
  const h=harness({native:true});
  const portrait={dataUrl:'data:image/png;base64,'+'B'.repeat(170000)};
  h.seed(80,portrait);
  const originalSave=h.bridge.card.saveSnapshot;
  const held=deferred();let waiting=false,hold=true;
  h.bridge.card.saveSnapshot=async value=>{
    if(hold){hold=false;waiting=true;await held.promise;}
    return originalSave(value);
  };
  const refreshing=h.service.refresh();
  await until(()=>waiting);
  await h.createOtherView().disconnect();
  held.resolve();
  await refreshing;
  const displayed=await h.service.getSnapshot();
  const persisted=await h.createOtherView().getSnapshot();
  assert.equal(displayed.stamina,null);
  assert.equal(displayed.profile,null);
  assert.equal(displayed.dashboard,null);
  assert.equal(persisted.stamina,null);
  assert.equal(displayed.sessionRevision,h.config.get('sessionRevision'));
  assert.equal(displayed.portrait.dataUrl,portrait.dataUrl);
  assert.equal(h.storage.has('endfield.auth'),false);
});

test('a hung card refresh expires, allows retry, and cannot publish its late response', async () => {
  const h = harness();
  h.seed(80);
  const late = deferred();
  h.fetch = () => late.promise;
  const first = h.service.refresh();
  const failed = assert.rejects(first, error => error.code === 'TIMEOUT');
  await until(() => h.fetchCalls === 1);
  h.fire(60000);
  await failed;
  assert.equal(h.snapshots.length, 0, 'timeout preserves the last published snapshot');
  h.fetch = async () => data(111, 3000);
  const retry = await h.service.refresh();
  assert.equal(retry.stamina.current, 111);
  assert.equal(h.fetchCalls, 2, 'the rejected request does not keep the running lock');
  const published = h.snapshots.length;
  late.resolve(data(5, 4000));
  for (let i = 0; i < 20; i++) await pause();
  assert.equal(h.snapshots.length, published, 'a timed-out response is obsolete even if its timestamp is newer');
  assert.equal((await h.service.getSnapshot()).stamina.current, 111);
  assert.equal(h.timers.size, 0);
});

test('a lost storage reply expires after 12 seconds and releases the shared read queue', async () => {
  const h = harness();
  h.seed(80);
  let held = false;
  h.hangRead = key => {
    if (!held && key === 'endfield.snapshot') { held = true; return true; }
    return false;
  };
  const first = h.service.getSnapshot();
  const failed = assert.rejects(first, error => error.code === 'TIMEOUT');
  const second = h.service.getSnapshot();
  await until(() => held);
  h.fire(12000);
  await failed;
  assert.equal((await second).stamina.current, 80);
  assert.equal((await h.service.getSnapshot()).stamina.current, 80);
  assert.equal(h.timers.size, 0);
});

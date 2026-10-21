'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const coreSource = fs.readFileSync(path.join(root, 'src/shared/core.js'), 'utf8');
const cacheSource = fs.readFileSync(path.join(root, 'src/shared/cache.js'), 'utf8');
const cardSource = fs.readFileSync(path.join(root, 'src/card/main.js'), 'utf8');

function snapshot() {
  return {
    schemaVersion: 1, settings: {},
    stamina: { current: 80, max: 240, updatedAt: Date.now(), recoveryAt: Date.now() + 3600000, secondsPerPoint: null },
    portrait: { dataUrl: 'data:image/png;base64,AA==' },
    profile: { name: '管理员#1234' }, syncedAt: Date.now()
  };
}

function runtime(cached, serviceOverrides) {
  const frames = [];
  const listeners = new Map();
  const counts = { fills: 0, images: 0, refreshes: 0, timerClears: 0, sources: 0 };
  const labels = [];
  const textPositions = [];
  const imageBoxes = [];
  const imageObjects = [];
  const refreshCallbacks = [];
  const timeouts = new Map();
  let now = Date.now(), nextTimeout = 0;
  class RuntimeDate extends Date { static now() { return now; } }
  const context = new Proxy({
    measureText: t => ({ width: String(t).length * 12 }),
    drawImage(image, x, y, w, h) { counts.images++; imageBoxes.push({ x, y, w, h, source: image.source }); },
    fillRect() { counts.fills++; },
    fillText(t, x, y) { labels.push(String(t)); textPositions.push({ text: String(t), x, y }); }
  }, { get: (o, k) => k in o ? o[k] : (() => {}), set: (o, k, v) => (o[k] = v, true) });
  const canvas = {
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 912, height: 596 }),
    addEventListener(k, f) { const list = listeners.get(k) || []; list.push(f); listeners.set(k, list); },
    removeEventListener(k, f) { listeners.set(k, (listeners.get(k) || []).filter(value => value !== f)); }
  };
  const service = Object.assign({
    // Hold asynchronous initialization pending to inspect the true synchronous first frame.
    getSnapshot: () => new Promise(() => {}), getSettings: async () => ({}),
    refresh: async () => { counts.refreshes++; return cached; }
  }, serviceOverrides);
  const sandbox = {
    document: { getElementById: () => canvas }, Date: RuntimeDate, Math, Number, Promise,
    Image: class {
      constructor() { imageObjects.push(this); }
      set src(value) { counts.sources++; this.source = value; this.width = 200; this.height = 400; if (this.onload) this.onload(); }
    },
    bridge: { card: { readSnapshot: () => cached, onRefresh(fn) { refreshCallbacks.push(fn); } }, config: { onChange() {} } },
    EndfieldService: { create: () => service },
    requestAnimationFrame: f => (frames.push(f), frames.length), cancelAnimationFrame() {},
    setInterval: () => 1, clearInterval: () => { counts.timerClears++; },
    setTimeout(fn, delay) { const id = ++nextTimeout; timeouts.set(id,{fn,at:now+delay}); return id; },
    clearTimeout(id) { timeouts.delete(id); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(cacheSource, sandbox);
  function execute() { vm.runInContext(cardSource, sandbox); }
  function emit(type, props) { for (const fn of listeners.get(type) || []) fn(Object.assign({ isPrimary: true }, props)); }
  function frame() { const fn = frames.shift(); if (fn) { labels.length = 0; textPositions.length = 0; fn(); } }
  function tick(milliseconds) { now += milliseconds; for (const [id,task] of timeouts) if(task.at<=now){timeouts.delete(id);task.fn();} }
  execute();
  return { counts, frames, labels, textPositions, imageBoxes, imageObjects, refreshCallbacks, listeners, sandbox, execute, emit, frame, tick, timeouts };
}

function tap(r, x, y, pointerId = 1) {
  r.emit('pointerdown', { pointerId, clientX: x, clientY: y });
  r.emit('pointerup', { pointerId, clientX: x, clientY: y });
  r.frame();
}

function swipe(r, from, to, pointerId = 1) {
  r.emit('pointerdown', { pointerId, clientX: from[0], clientY: from[1] });
  r.emit('pointermove', { pointerId, clientX: to[0], clientY: to[1] });
  r.emit('pointerup', { pointerId, clientX: to[0], clientY: to[1] });
  r.frame();
}

test('cached data and portrait are prepared synchronously; drawing waits for RAF', () => {
  const r = runtime(snapshot());
  assert.equal(r.counts.fills, 0);
  assert.equal(r.counts.sources, 1);
  assert.equal(r.frames.length, 1);
  r.frame();
  assert.equal(r.counts.images, 1);
  assert(r.labels.includes('80'));
  assert.equal(r.frames.length, 0, 'static frame must not schedule a permanent RAF loop');
});

test('packed native snapshot restores the exact high-resolution art before the first asynchronous frame', () => {
  const cached=snapshot();
  cached.portrait.dataUrl='data:image/webp;base64,'+'AB+/'.repeat(112000);
  cached.dashboard={glory:{displayKnown:true,displayCount:1,medals:[{id:'m',name:'展示蚀刻章',iconDataUrl:'data:image/png;base64,AA=='}]}};
  const codec={};vm.createContext(codec);vm.runInContext(cacheSource,codec);
  const packed=codec.EndfieldCache.pack(cached);
  assert.equal(packed.endfieldPackedSnapshot,1);
  const r=runtime(JSON.parse(JSON.stringify(packed)));
  assert.equal(r.counts.sources,2,'portrait and medal restore before any promise callback');
  assert.equal(r.imageObjects[0].source,cached.portrait.dataUrl);
  r.frame();
  assert(r.labels.includes('80'));
  assert(r.labels.includes('管理员#1234'));
  assert.equal(r.counts.images,1);
});

test('drag and cancelled gestures do not cause refresh; a stationary tap does', () => {
  const r = runtime(snapshot());
  r.frame();
  r.emit('pointerdown', { pointerId: 1, clientX: 800, clientY: 550 });
  r.emit('pointermove', { pointerId: 1, clientX: 600, clientY: 550 });
  r.emit('pointerup', { pointerId: 1, clientX: 800, clientY: 550 });
  assert.equal(r.counts.refreshes, 0);
  r.emit('pointerdown', { pointerId: 2, clientX: 800, clientY: 550 });
  r.emit('pointercancel', { pointerId: 2 });
  r.emit('pointerup', { pointerId: 2, clientX: 800, clientY: 550 });
  assert.equal(r.counts.refreshes, 0);
  r.emit('pointerdown', { pointerId: 3, clientX: 800, clientY: 550 });
  r.emit('pointerup', { pointerId: 3, clientX: 800, clientY: 550 });
  assert.equal(r.counts.refreshes, 1);
  r.emit('pointerdown', { pointerId: 4, clientX: 800, clientY: 550 });
  r.emit('pointerup', { pointerId: 4, clientX: 800, clientY: 550 });
  assert.equal(r.counts.refreshes, 1, 'repeated taps coalesce with an in-flight request');
});

test('hot reload disposes timer and old pointer handlers', () => {
  const r = runtime(snapshot());
  r.execute();
  assert.equal(r.counts.timerClears, 1);
  assert.equal(r.listeners.get('pointerdown').length, 1);
  assert.equal(r.listeners.get('pointerup').length, 1);
  r.frame();
  assert.equal(r.counts.fills, 0, 'an already queued callback from the old instance is inert');
  r.frame();
  assert(r.counts.fills > 0);
});

test('a lost sync result leaves the last data visible, releases the button and ignores late results', async () => {
  const old = snapshot(), fresh = snapshot(), late = snapshot();
  fresh.stamina.current=123; late.stamina.current=999;
  let calls=0, release;
  const r=runtime(old,{refresh:()=>{
    calls++;
    return calls===1 ? new Promise(resolve=>{release=resolve;}) : Promise.resolve(fresh);
  }});
  r.frame(); tap(r,800,550);
  assert(r.labels.includes('同步中'));
  r.tick(65000); r.frame();
  assert(r.labels.includes('同步超时'));
  assert(r.labels.includes('80'));
  assert(r.labels.includes('刷新理智'));
  tap(r,800,550);
  await new Promise(resolve=>setImmediate(resolve));r.frame();
  assert.equal(calls,2);
  assert(r.labels.includes('123'));
  assert(!r.labels.includes('同步超时'));
  release(late);
  await new Promise(resolve=>setImmediate(resolve));r.frame();
  assert(!r.labels.includes('999'));
  assert.equal(r.timeouts.size,0);
});

test('sync error messages distinguish timeouts from expired login and never echo secrets', async () => {
  for(const [code,label] of [['TIMEOUT','同步超时'],['AUTH','登录已失效，请在主屏设置中重新连接'],['NETWORK','同步未完成，保留上次数据，点按重试']]){
    const r=runtime(snapshot(),{refresh:async()=>{const error=new Error('private-credential');error.code=code;throw error;}});
    r.frame();tap(r,800,550);
    await new Promise(resolve=>setImmediate(resolve));r.frame();
    assert(r.labels.includes(label));
    assert(r.labels.includes('80'));
    assert(r.labels.includes('刷新理智'));
    assert(!r.labels.some(text=>text.includes('private-credential')));
    assert.equal(r.timeouts.size,0);
  }
});

test('unknown or malformed snapshots show an empty state', () => {
  const r = runtime({ schemaVersion: 1, settings: {}, stamina: { current: '80', max: 240 } });
  r.frame();
  assert(r.labels.includes('--'));
  assert(r.labels.includes('等待账号同步'));
  assert(!r.labels.includes('80'));
});

test('past recovery deadline remains clearly estimated until the next API result', () => {
  const cached = snapshot();
  cached.stamina.recoveryAt = Date.now() - 60000;
  cached.stamina.updatedAt = Date.now() - 120000;
  const r = runtime(cached);
  r.frame();
  assert(r.labels.includes('80'), 'do not invent a regeneration rate or revised number');
  assert(r.labels.includes('预计已回满 · 待同步'));
  assert(!r.labels.some(value => value.includes('已回满后回满')));
});

test('horizontal swipes cycle three pages and never trigger a network refresh', () => {
  const r = runtime(snapshot());
  r.frame();
  swipe(r, [800, 320], [500, 330]);
  assert(r.labels.includes('光荣之路'));
  swipe(r, [800, 320], [500, 320]);
  assert(r.labels.includes('干员养成'));
  swipe(r, [800, 320], [500, 320]);
  assert(r.labels.includes('管理员#1234'));
  swipe(r, [500, 320], [800, 320]);
  assert(r.labels.includes('干员养成'), 'right swipe wraps from overview to operators');
  assert.equal(r.counts.refreshes, 0);
  assert.equal(r.counts.sources, 1, 'page changes reuse the already decoded portrait');
  assert.equal(r.frames.length, 0, 'navigation draws only when needed');
});

test('showcase freshness keeps its own manual-sync time after a stamina refresh', () => {
  for (const previous of [new Date(2026, 9, 21, 4, 15).getTime(), 0, undefined]) {
    const cached = snapshot();
    cached.syncedAt = new Date(2026, 9, 21, 5, 10).getTime();
    if (previous !== undefined) cached.detailsSyncedAt = previous;
    const r = runtime(cached); r.frame();
    assert(r.labels.includes('同步于 05:10'));
    swipe(r, [800, 320], [500, 320]);
    assert(r.labels.includes(previous === 0 ? '请在设置页同步资料' : previous === undefined ? '同步于 05:10' : '同步于 04:15'));
  }
});

test('vertical, diagonal, cancelled and multi-pointer gestures do not navigate', () => {
  const r = runtime(snapshot());
  r.frame();
  swipe(r, [800, 200], [780, 480]);
  assert(r.labels.includes('管理员#1234'));
  swipe(r, [800, 200], [600, 400]);
  assert(r.labels.includes('管理员#1234'));
  // A gesture locked vertically must stay vertical even if it later turns sideways.
  r.emit('pointerdown', { pointerId: 1, clientX: 800, clientY: 200 });
  r.emit('pointermove', { pointerId: 1, clientX: 800, clientY: 240 });
  r.emit('pointerup', { pointerId: 1, clientX: 500, clientY: 240 });
  r.frame();
  assert(r.labels.includes('管理员#1234'));
  r.emit('pointerdown', { pointerId: 1, clientX: 800, clientY: 200 });
  r.emit('pointermove', { pointerId: 1, clientX: 500, clientY: 200 });
  r.emit('pointercancel', { pointerId: 1 });
  r.emit('pointerup', { pointerId: 1, clientX: 500, clientY: 200 });
  r.frame();
  assert(r.labels.includes('管理员#1234'));
  r.emit('pointerdown', { pointerId: 1, clientX: 800, clientY: 200 });
  r.emit('pointerdown', { pointerId: 2, clientX: 720, clientY: 200, isPrimary: false });
  r.emit('pointerup', { pointerId: 1, clientX: 500, clientY: 200 });
  r.emit('pointerup', { pointerId: 2, clientX: 720, clientY: 200, isPrimary: false });
  r.frame();
  assert(r.labels.includes('管理员#1234'));
  swipe(r, [100, 200], [500, 200]);
  assert(r.labels.includes('管理员#1234'), 'camera side never starts a gesture');
  assert.equal(r.counts.refreshes, 0);
});

test('navigation shows unknown data as unavailable and keeps displayed operators separate from owned count', () => {
  const cached = snapshot();
  cached.dashboard = { glory: { count: null, medals: [] }, operatorCount: 28, operators: [] };
  const r = runtime(cached);
  r.frame();
  tap(r, 520, 550);
  assert(r.labels.includes('光荣之路'));
  assert(r.labels.includes('请同步蚀刻章展示信息'));
  tap(r, 630, 550);
  assert(r.labels.includes('干员养成'));
  assert(r.labels.includes('暂无干员养成数据'));
  assert(r.labels.includes('已拥有 28 位干员'));
});

test('operators, all skill pages, equipment and medal pages can be browsed independently', () => {
  const cached = snapshot();
  cached.dashboard = {
    glory: { count: 99, displayKnown: true, displayCount: 7, medals: Array.from({ length: 7 }, (_, i) => ({ name: '蚀刻章' + i, category: '探索', level: 2, isPlated: i === 6 })) },
    operatorCount: 28,
    operators: [
      { name: '陈千语', level: 80, evolvePhase: 3, potentialLevel: 2, weapon: { name: '测试武器', level: 60, refineLevel: 1, breakthroughLevel: 2 },
        skills: Array.from({ length: 5 }, (_, i) => ({ name: '技能' + i, level: i + 1 })), equipment: [{ slot: 'bodyEquip', name: '测试护甲', level: '70' }] },
      { name: '佩丽卡', level: null, evolvePhase: null, potentialLevel: null, weapon: null, skills: [], equipment: [] }
    ]
  };
  const r = runtime(cached);
  r.frame();
  tap(r, 520, 550);
  assert(!r.labels.includes('99'), 'the showcase does not substitute a large achievement total for the selected artwork');
  assert(r.labels.includes('蚀刻章0'));
  assert(r.labels.includes('蚀刻章5'));
  assert(!r.labels.includes('蚀刻章6'));
  tap(r, 850, 190);
  assert(r.labels.includes('蚀刻章6'));
  assert(!r.labels.includes('蚀刻章0'));
  tap(r, 630, 550);
  assert(r.labels.includes('陈千语'));
  assert(r.labels.includes('晋升 3 · 潜能 2'));
  assert(r.labels.includes('展示干员 1/2 · 拥有 28'));
  assert(r.labels.includes('技能0'));
  tap(r, 830, 366);
  assert(r.labels.includes('技能4'), 'skills beyond the first four remain reachable');
  tap(r, 470, 366);
  assert(r.labels.includes('测试护甲'));
  assert(r.labels.includes('护甲 · Lv.70'));
  tap(r, 850, 185);
  assert(r.labels.includes('佩丽卡'));
  assert(r.labels.includes('Lv.--'));
  assert(r.labels.includes('暂未提供装备资料'));
  assert(!r.labels.includes('Lv.0'));
  assert.equal(r.counts.refreshes, 0);
});

test('showcase image data is decoded before asynchronous work and reused across navigation and refreshes', async () => {
  const cached = snapshot();
  const one = 'data:image/png;base64,AAAA', two = 'data:image/webp;base64,BBBB';
  cached.dashboard = {glory:{displayKnown:true,displayCount:7,medals:Array.from({length:7}, (_,i)=>({
    id:'selected-'+i,name:'蚀刻章'+i,slot:String(i+1),iconDataUrl:i%2?two:one
  }))}};
  const r = runtime(cached,{getSnapshot:async()=>cached,getSettings:async()=>cached.settings});
  assert.equal(r.counts.sources,3,'portrait and two unique medal Data URLs are ready synchronously');
  assert.equal(r.counts.images,0,'images are still drawn only in RAF');
  await new Promise(resolve=>setImmediate(resolve));
  r.frame();
  tap(r,520,550);
  const icons = r.imageBoxes.filter(box=>box.source===one||box.source===two);
  assert.equal(icons.length,6);
  assert(icons.every(box=>box.w===50&&box.h===100),'gallery preserves icon aspect ratio inside the 100px box');
  assert(r.labels.includes('蚀刻章0'));
  assert(!r.labels.includes('待同步图案'));
  tap(r,850,190);
  assert(r.labels.includes('蚀刻章6'));
  assert.equal(r.counts.sources,3);
  r.refreshCallbacks.forEach(fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));
  r.frame();
  assert.equal(r.counts.sources,3,'identical cached images are not decoded again');
  const oldIcons = r.imageObjects.slice(1);
  cached.dashboard.glory.medals=[];
  cached.dashboard.glory.displayCount=0;
  r.refreshCallbacks.forEach(fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));
  r.frame();
  assert(r.labels.includes('尚未设置展示蚀刻章'));
  assert(oldIcons.every(image=>image.onload===null&&image.onerror===null),'unused images release their handlers');
});

test('legacy unselected medals and missing image data never masquerade as a real showcase', () => {
  const cached = snapshot();
  cached.dashboard = {glory:{count:99,medals:[{name:'不应展示的旧章',iconDataUrl:'data:image/png;base64,AAAA'}]}};
  const old = runtime(cached);
  old.frame();tap(old,520,550);
  assert(old.labels.includes('请同步蚀刻章展示信息'));
  assert(!old.labels.includes('不应展示的旧章'));
  assert.equal(old.counts.sources,1,'legacy medals are not even decoded');
  cached.dashboard.glory={displayKnown:true,displayCount:2,medals:[
    {name:'缺少图片',iconUrl:'https://cdn.example/image.png'},
    {name:'无效图片',iconDataUrl:'data:image/png;base64,'+'A'.repeat(24000)}
  ]};
  const pending = runtime(cached);
  pending.frame();tap(pending,520,550);
  assert(pending.labels.includes('缺少图片'));
  assert(pending.labels.includes('待同步图案'));
  assert.equal(pending.counts.sources,1,'remote URLs and oversized image data are not loaded by Canvas');
  assert.equal(pending.counts.images,2,'only the portrait draws on the two frames');
  const ready = snapshot();ready.dashboard={glory:{displayKnown:true,displayCount:1,medals:[{name:'测试章',iconDataUrl:'data:image/png;base64,AAAA'}]}};
  const hot = runtime(ready), oldImage = hot.imageObjects[1];
  hot.execute();
  assert.equal(oldImage.onload,null);
  assert.equal(oldImage.onerror,null);
});

test('portrait uses the enlarged viewport and user-controlled scale', () => {
  const cached = snapshot();
  cached.settings = { fit: 'contain', portraitScale: 2 };
  const r = runtime(cached);
  r.frame();
  assert.equal(r.imageBoxes[0].h, 478 * 2);
  assert.equal(r.imageBoxes[0].w, 239 * 2);
});

test('missing portrait hint stays in the overview right half and is absent from data pages', () => {
  const cached = snapshot();
  cached.portrait = null;
  const r = runtime(cached);
  r.frame();
  const hint = r.textPositions.find(value => value.text === '在设置中添加立绘');
  assert(hint);
  assert.equal(hint.y, 365);
  assert(hint.x >= 360 + (876 - 360) * 0.55);
  tap(r, 520, 550);
  assert(!r.labels.includes('在设置中添加立绘'));
  tap(r, 630, 550);
  assert(!r.labels.includes('在设置中添加立绘'));
});

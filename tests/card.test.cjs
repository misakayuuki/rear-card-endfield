'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const coreSource = fs.readFileSync(path.join(root, 'src/shared/core.js'), 'utf8');
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
  const context = new Proxy({
    measureText: t => ({ width: String(t).length * 12 }),
    drawImage(image, x, y, w, h) { counts.images++; imageBoxes.push({ x, y, w, h }); },
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
    document: { getElementById: () => canvas }, Date, Math, Number, Promise,
    Image: class {
      set src(value) { counts.sources++; this.width = 200; this.height = 400; if (this.onload) this.onload(); }
    },
    bridge: { card: { readSnapshot: () => cached, onRefresh() {} }, config: { onChange() {} } },
    EndfieldService: { create: () => service },
    requestAnimationFrame: f => (frames.push(f), frames.length), cancelAnimationFrame() {},
    setInterval: () => 1, clearInterval: () => { counts.timerClears++; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  function execute() { vm.runInContext(cardSource, sandbox); }
  function emit(type, props) { for (const fn of listeners.get(type) || []) fn(Object.assign({ isPrimary: true }, props)); }
  function frame() { const fn = frames.shift(); if (fn) { labels.length = 0; textPositions.length = 0; fn(); } }
  execute();
  return { counts, frames, labels, textPositions, imageBoxes, listeners, sandbox, execute, emit, frame };
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
  assert(r.labels.includes('--'));
  assert(r.labels.includes('暂无可展示奖章'));
  tap(r, 630, 550);
  assert(r.labels.includes('干员养成'));
  assert(r.labels.includes('暂无干员养成数据'));
  assert(r.labels.includes('已拥有 28 位干员'));
});

test('operators, all skill pages, equipment and medal pages can be browsed independently', () => {
  const cached = snapshot();
  cached.dashboard = {
    glory: { count: 99, medals: Array.from({ length: 4 }, (_, i) => ({ name: '奖章' + i, category: '探索', level: 2, isPlated: i === 3 })) },
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
  assert(r.labels.includes('99'));
  assert(r.labels.includes('奖章0'));
  tap(r, 850, 275);
  assert(r.labels.includes('奖章3'));
  assert(r.labels.includes('探索 · Lv.2 · 镀层'));
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

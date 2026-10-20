const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../src/shared/core.js');
const C = globalThis.EndfieldCore;
const t = 1800000000000;
test('distinguishes zero stamina from missing data', () => {
  assert.equal(C.deriveStamina(null, t), null);
  assert.equal(C.deriveStamina({current: 0, max: 240, updatedAt: t}, t).current, 0);
  assert.equal(C.deriveStamina({current: 0, max: 0, updatedAt: t}, t), null);
});
test('uses exact recovery timestamp and partial tick rather than timer accumulation', () => {
  const s = {current: 120, max: 240, updatedAt: t, recoveryAt: t + 119 * 360000 + 120000, secondsPerPoint: 360};
  assert.equal(C.deriveStamina(s, t).current, 120);
  assert.equal(C.deriveStamina(s, t + 119000).current, 120);
  assert.equal(C.deriveStamina(s, t + 120000).current, 121);
  const restored = C.deriveStamina(s, s.recoveryAt + 10000);
  assert.equal(restored.current, 240);
  assert.equal(restored.estimated, true);
  assert.equal(restored.full, true);
  assert.equal(restored.stale, true);
});
test('unknown rate never invents a current value; overflow is retained', () => {
  assert.equal(C.deriveStamina({current: 100, max: 240, updatedAt: t, recoveryAt: t+1000}, t+2000).current,100);
  assert.equal(C.deriveStamina({current: 300, max: 240, updatedAt: t}, t+2000).current,300);
});
test('clock rollback does not subtract stamina and settings are bounded', () => {
  assert.equal(C.deriveStamina({current: 120,max: 240, updatedAt:t,recoveryAt:t+1000,secondsPerPoint:360},t-60000).current,120);
  const s = C.sanitizeSettings({safeLeft:999, refreshMinutes:1, accent:'javascript:bad', characterName:'长'.repeat(40)});
  assert.equal(s.safeLeft,500); assert.equal(s.refreshMinutes,5);
  assert.equal(s.accent,'#E5F56A'); assert.equal(s.characterName.length,30);
  assert.equal(s.portraitScale,1.2);
  assert.equal(C.sanitizeSettings({portraitScale:9}).portraitScale,2.5);
  assert.equal(C.sanitizeSettings({portraitScale:-1}).portraitScale,1);
});

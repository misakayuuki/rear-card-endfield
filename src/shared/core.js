(function (root) {
  'use strict';
  var DEFAULTS = {
    accent: '#E5F56A', safeLeft: 336, characterName: '', fit: 'cover',
    portraitPositionX: 50, portraitPositionY: 40, portraitScale: 1.2, refreshMinutes: 15
  };
  function number(value, fallback, min, max) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  function sanitizeSettings(value) {
    var v = value || {};
    return {
      accent: /^#[0-9a-f]{6}$/i.test(v.accent || '') ? v.accent : DEFAULTS.accent,
      safeLeft: number(v.safeLeft, 336, 0, 500),
      characterName: String(v.characterName || '').slice(0, 30),
      fit: v.fit === 'contain' ? 'contain' : 'cover',
      portraitPositionX: number(v.portraitPositionX, 50, 0, 100),
      portraitPositionY: number(v.portraitPositionY, 40, 0, 100),
      portraitScale: number(v.portraitScale, 1.2, 1, 2.5),
      refreshMinutes: Math.round(number(v.refreshMinutes, 15, 5, 120))
    };
  }
  function validStamina(v) {
    return !!v && Number.isFinite(v.current) && v.current >= 0 &&
      Number.isFinite(v.max) && v.max > 0 && Number.isFinite(v.updatedAt) && v.updatedAt > 0;
  }
  function deriveStamina(stamina, now) {
    if (!validStamina(stamina)) return null;
    now = Number.isFinite(now) ? now : Date.now();
    var current = stamina.current;
    var full = current >= stamina.max;
    var recovery = Number(stamina.recoveryAt) || 0;
    var seconds = Number(stamina.secondsPerPoint) || 0;
    var elapsed = Math.max(0, now - stamina.updatedAt);
    var estimated = false;
    if (!full && recovery > stamina.updatedAt && seconds > 0 && now > stamina.updatedAt) {
      // Work backwards from the server's full-recovery time to retain partial tick progress.
      var projected = Math.max(current, stamina.max - Math.ceil(Math.max(0, recovery - now) / (seconds * 1000)));
      current = Math.min(stamina.max, projected);
      estimated = current !== stamina.current;
    }
    full = current >= stamina.max;
    return {
      current: current, max: stamina.max, full: full, estimated: estimated,
      remainingMs: full ? 0 : (recovery > 0 ? Math.max(0, recovery - now) : null),
      stale: elapsed > 30 * 60 * 1000,
      updatedAt: stamina.updatedAt
    };
  }
  function formatDuration(ms) {
    if (ms === null || !Number.isFinite(ms)) return '等待同步';
    var minutes = Math.max(0, Math.ceil(ms / 60000));
    if (!minutes) return '已回满';
    var hours = Math.floor(minutes / 60);
    return (hours ? hours + '小时 ' : '') + (minutes % 60) + '分钟';
  }
  function validSnapshot(v) {
    return !!v && v.schemaVersion === 1 && typeof v.settings === 'object' &&
      (!v.stamina || validStamina(v.stamina));
  }
  root.EndfieldCore = { defaults: DEFAULTS, sanitizeSettings: sanitizeSettings,
    validStamina: validStamina, deriveStamina: deriveStamina,
    formatDuration: formatDuration, validSnapshot: validSnapshot };
})(typeof window !== 'undefined' ? window : globalThis);

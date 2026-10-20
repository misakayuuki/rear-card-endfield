(function (root) {
  'use strict';
  var Core = root.EndfieldCore;
  var KEYS = { auth: 'endfield.auth', roles: 'endfield.roles', characters: 'endfield.characters', snapshot: 'endfield.snapshot', portrait: 'endfield.portrait' };
  function create(bridge) {
    var api = root.EndfieldAPI.create(bridge);
    var running = null;
    var generation = 0;
    var sessionCounter = 0;
    function cancelled() { var error = new Error('账号已变更，请重新操作。'); error.code = 'CANCELLED'; return error; }
    async function sessionId() { return String(await bridge.config.get('sessionRevision') || ''); }
    async function context() {
      var localGeneration = generation;
      var session = await sessionId();
      var role = await bridge.config.get('role');
      return { session: session, roleId: role && role.id || '', generation: localGeneration };
    }
    async function isCurrent(expected) {
      if (generation !== expected.generation) return false;
      var role = await bridge.config.get('role');
      var session = await sessionId();
      return generation === expected.generation && session === expected.session && (role && role.id || '') === expected.roleId;
    }
    async function newSession() {
      var revision = Date.now().toString(36) + '-' + (++sessionCounter) + '-' + Math.random().toString(36).slice(2);
      await bridge.config.set('sessionRevision', revision);
      return revision;
    }
    async function getSettings() { return Core.sanitizeSettings(await bridge.config.get('settings')); }
    async function getSnapshot() {
      var currentSession = await sessionId();
      var value = await bridge.storage.get(KEYS.snapshot);
      return Core.validSnapshot(value) && String(value.sessionRevision || '') === currentSession ? value : null;
    }
    async function repairLatePublication() {
      var expected = await context();
      var value = await getSnapshot();
      if (!value) {
        value = { schemaVersion: 1, sessionRevision: expected.session, settings: await getSettings(),
          stamina: null, profile: null, dashboard: null, portrait: await bridge.storage.get(KEYS.portrait), syncedAt: 0, error: null };
      }
      if (await isCurrent(expected)) {
        await bridge.card.saveSnapshot(value);
        await bridge.card.requestRefresh();
      }
      return value;
    }
    async function publish(stamina, profile, error, expected, preserveNewer, dashboard) {
      expected = expected || await context();
      // Never batch large image reads: HostVar sync results have a practical ~200K limit.
      var settings = await getSettings();
      var portrait = await bridge.storage.get(KEYS.portrait);
      if (preserveNewer) {
        var latest = await getSnapshot();
        if (latest && latest.stamina && (!stamina || latest.stamina.updatedAt > stamina.updatedAt)) {
          stamina = latest.stamina; profile = latest.profile; dashboard = latest.dashboard;
          // A settings save must not reintroduce a failure that a fresh API result cleared.
          if (preserveNewer === 'appearance') error = latest.error;
        }
      }
      // This check must follow the image read, which can take a full bridge round trip.
      if (!await isCurrent(expected)) return getSnapshot();
      var snapshot = { schemaVersion: 1, sessionRevision: expected.session, settings: settings, stamina: stamina || null,
        profile: profile || null, dashboard: dashboard || null, portrait: portrait || null,
        syncedAt: stamina ? stamina.updatedAt : 0, error: error || null };
      await bridge.storage.set(KEYS.snapshot, snapshot);
      if (!await isCurrent(expected)) return getSnapshot();
      await bridge.card.saveSnapshot(snapshot);
      if (!await isCurrent(expected)) return repairLatePublication();
      // Snapshot writes refresh the carrier cache, but do not notify its drawing code.
      await bridge.card.requestRefresh();
      return snapshot;
    }
    async function republish() {
      var expected = await context();
      var old = await getSnapshot();
      return publish(old && old.stamina, old && old.profile, old && old.error, expected, 'appearance', old && old.dashboard);
    }
    async function saveSettings(value) {
      await bridge.config.set('settings', Core.sanitizeSettings(value));
      return republish();
    }
    async function setPortrait(dataUrl) {
      if (dataUrl && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 160000)) {
        throw new Error('立绘需为 PNG、JPEG 或 WebP，压缩后不超过 160K 字符。');
      }
      if (dataUrl) await bridge.storage.set(KEYS.portrait, { dataUrl: dataUrl });
      else await bridge.storage.remove(KEYS.portrait);
      return republish();
    }
    async function connect(accountToken) {
      var intent = ++generation;
      var previousSession = await sessionId();
      var result = await api.connect(accountToken);
      if (!result.roles || !result.roles.length) throw new Error('该森空岛账号没有绑定终末地角色，请先在森空岛绑定。');
      if (generation !== intent || previousSession !== await sessionId()) throw cancelled();
      var revision = await newSession();
      await bridge.config.set('role', null);
      if (generation !== intent || revision !== await sessionId()) throw cancelled();
      await bridge.storage.set(KEYS.auth, Object.assign({}, result.auth, { sessionRevision: revision }));
      if (generation !== intent || revision !== await sessionId()) throw cancelled();
      await bridge.storage.set(KEYS.roles, result.roles);
      await bridge.storage.remove(KEYS.characters);
      await publish(null, null, null, { session: revision, roleId: '', generation: intent });
      return result.roles;
    }
    async function getRoles() { return await bridge.storage.get(KEYS.roles) || []; }
    async function getCharacters() { return await bridge.storage.get(KEYS.characters) || []; }
    async function downloadPortrait(id) {
      var characters = await getCharacters();
      var character = characters.find(function (c) { return c.id === id; });
      if (!character || !/^https:\/\//i.test(character.url)) throw new Error('该角色暂未提供可下载的立绘，请使用本地上传。');
      var response = await bridge.net.request({ url: character.url, responseType: 'base64', timeoutMs: 15000 });
      if (response.status !== 200 || !response.bodyBase64) throw new Error('立绘下载失败，请使用本地上传。');
      var headers = response.headers || {};
      var contentType = (headers['content-type'] || [''])[0].split(';')[0].toLowerCase();
      if (!/^image\/(png|jpeg|webp)$/.test(contentType)) throw new Error('立绘格式不支持，请使用 PNG、JPEG 或 WebP 图片。');
      return 'data:' + contentType + ';base64,' + response.bodyBase64;
    }
    async function selectRole(role) {
      var intent = ++generation;
      var previousSession = await sessionId();
      var roles = await getRoles();
      var selected = roles.find(function (r) { return r.id === role.id; });
      if (!selected) throw new Error('请选择已绑定的角色。');
      if (generation !== intent || previousSession !== await sessionId()) throw cancelled();
      await bridge.config.set('role', selected);
      await bridge.storage.remove(KEYS.characters);
      var expected = { session: previousSession, roleId: selected.id, generation: intent };
      await publish(null, { name: selected.name, server: selected.server }, null, expected);
      if (!await isCurrent(expected)) throw cancelled();
      // An older role's request may still be running. It is invalidated by generation;
      // wait for it before starting this role's request instead of reusing its result.
      if (running) { try { await running; } catch (_) { /* The old account error is obsolete. */ } }
      if (!await isCurrent(expected)) throw cancelled();
      return refresh();
    }
    async function disconnect() {
      var intent = ++generation;
      var revision = await newSession();
      await bridge.config.set('role', null);
      await bridge.storage.remove(KEYS.auth);
      await bridge.storage.remove(KEYS.roles);
      await bridge.storage.remove(KEYS.characters);
      await publish(null, null, null, { session: revision, roleId: '', generation: intent });
    }
    async function performRefresh() {
      var expected = await context();
      var role = await bridge.config.get('role');
      var auth = await bridge.storage.get(KEYS.auth);
      if (!await isCurrent(expected)) return getSnapshot();
      if (!role || !auth || String(auth.sessionRevision || '') !== expected.session) return publish(null, null, null, expected);
      try {
        var result = await api.fetchStamina(auth, role);
        if (!Core.validStamina(result.stamina)) throw new Error('森空岛未返回有效体力数据，请稍后刷新。');
        if (!await isCurrent(expected)) return getSnapshot();
        if (Array.isArray(result.characters)) await bridge.storage.set(KEYS.characters, result.characters);
        // Do not persist rotated session tokens here: another view may have disconnected meanwhile.
        return await publish(result.stamina, result.profile, null, expected, true, result.dashboard);
      } catch (error) {
        if (!await isCurrent(expected)) return getSnapshot();
        var old = await getSnapshot();
        // No raw response/error payloads or credentials enter a public snapshot or log.
        var message = error && error.code === 'TIMEOUT' ? '同步超时，保留上次数据' : '同步失败，请在设置页检查登录';
        await publish(old && old.stamina, old && old.profile, message, expected, true, old && old.dashboard);
        throw error;
      }
    }
    function refresh() {
      if (running) return running;
      running = performRefresh().then(function (result) { running = null; return result; },
        function (error) { running = null; throw error; });
      return running;
    }
    return { getSettings: getSettings, saveSettings: saveSettings, getSnapshot: getSnapshot,
      connect: connect, getRoles: getRoles, getCharacters: getCharacters, downloadPortrait: downloadPortrait,
      selectRole: selectRole, disconnect: disconnect,
      refresh: refresh, setPortrait: setPortrait };
  }
  root.EndfieldService = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);

(function (root) {
  'use strict';
  var ORIGIN = 'https://zonai.skland.com';
  var USER_AGENT = 'Skland/1.32.1 (com.hypergryph.skland; build:103201004; Android 33; ) Okhttp/4.11.0';

  function failure(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }
  function text(value) { return value === undefined || value === null ? '' : String(value); }
  function parseAccountToken(input) {
    var value = text(input).trim();
    if (value.charAt(0) === '{' || value.charAt(0) === '"') {
      try {
        var parsed = JSON.parse(value);
        value = typeof parsed === 'string' ? parsed : text(parsed && parsed.data && parsed.data.content);
      } catch (_) { throw failure('INPUT', '粘贴的登录信息不是有效 JSON，请复制 content 的值。'); }
    }
    value = value.trim();
    if (!value || value.length > 8192 || /[\s\u0000-\u001f]/.test(value) || /^https?:/i.test(value)) {
      throw failure('INPUT', '请填写鹰角通行证 Token，或粘贴 account/info/hg 返回的完整 JSON。');
    }
    return value;
  }
  function epoch(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n < 100000000000 ? n * 1000 : n) : null;
  }
  function finiteValue(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function label(value, limit) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, limit || 48) : '';
  }
  function count(value) {
    var n = finiteValue(value);
    return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function jsonBytes(value) {
    var encoded = JSON.stringify(value), bytes = 0;
    for (var i = 0; i < encoded.length; i++) {
      var c = encoded.charCodeAt(i);
      if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }
  function normalizeDashboard(detail) {
    var source = record(detail.achieve);
    var medals = Array.isArray(source.achieveMedals) ? source.achieveMedals : [];
    var chars = Array.isArray(detail.chars) ? detail.chars : [];
    var dashboard = { glory: null, operatorCount: count(record(detail.base).charNum), operators: [],
      operatorsTruncated: chars.length > 64, medalsTruncated: medals.length > 32 };
    // These are the account's displayed medals, not a complete achievement catalogue.
    if (Object.keys(source).length) {
      dashboard.glory = { count: count(source.count), medals: [] };
      var medalIds = Object.create(null);
      medals.slice(0, 32).forEach(function (value) {
        var medal = record(value), data = record(medal.achievementData);
        var id = label(data.id, 80), name = label(data.name);
        if ((!id && !name) || (id && medalIds[id])) return;
        if (id) medalIds[id] = true;
        dashboard.glory.medals.push({ id: id, name: name, category: label(data.cateName),
          level: count(medal.level), isPlated: typeof medal.isPlated === 'boolean' ? medal.isPlated : null });
      });
    }
    var operatorIds = Object.create(null);
    chars.slice(0, 64).forEach(function (value) {
      var entry = record(value), character = record(entry.charData);
      var id = label(character.id, 80), name = label(character.name);
      if ((!id && !name) || (id && operatorIds[id])) return;
      if (id) operatorIds[id] = true;
      var weapon = record(entry.weapon), weaponData = record(weapon.weaponData);
      var skills = [], equipment = [], skillIds = Object.create(null), userSkills = record(entry.userSkills);
      (Array.isArray(character.skills) ? character.skills : []).slice(0, 8).forEach(function (value) {
        var skill = record(value), skillId = label(skill.id, 80);
        if (!skillId || skillIds[skillId]) return;
        skillIds[skillId] = true;
        skills.push({ id: skillId, name: label(skill.name), level: count(record(userSkills[skillId]).level) });
      });
      ['bodyEquip', 'armEquip', 'firstAccessory', 'secondAccessory'].forEach(function (slot) {
        var equip = record(record(entry[slot]).equipData), equipName = label(equip.name);
        if (equipName) equipment.push({ slot: slot, name: equipName, level: label(record(equip.level).value, 16) || null });
      });
      dashboard.operators.push({ id: id, name: name, level: count(entry.level), evolvePhase: count(entry.evolvePhase),
        potentialLevel: count(entry.potentialLevel), rarity: label(record(character.rarity).value, 16) || null,
        weapon: Object.keys(weapon).length ? { name: label(weaponData.name), level: count(weapon.level),
          refineLevel: count(weapon.refineLevel), breakthroughLevel: count(weapon.breakthroughLevel) } : null,
        skills: skills, equipment: equipment });
    });
    // Leave room for the portrait in the bridge snapshot, including multibyte Chinese text.
    while (jsonBytes(dashboard) > 24 * 1024) {
      if (dashboard.operators.length) { dashboard.operators.pop(); dashboard.operatorsTruncated = true; }
      else if (dashboard.glory && dashboard.glory.medals.length) { dashboard.glory.medals.pop(); dashboard.medalsTruncated = true; }
      else break;
    }
    return dashboard;
  }
  function parseRoles(data) {
    var result = [];
    var seen = {};
    var apps = data && Array.isArray(data.list) ? data.list : [];
    apps.forEach(function (app) {
      if (app.appCode !== 'endfield') return;
      (Array.isArray(app.bindingList) ? app.bindingList : []).forEach(function (binding) {
        if (binding.isDelete) return;
        var roles = Array.isArray(binding.roles) ? binding.roles : [];
        if (!roles.length && binding.defaultRole) roles = [binding.defaultRole];
        roles.forEach(function (role) {
          var roleId = text(role.roleId);
          var serverId = text(role.serverId);
          var id = roleId + ':' + serverId;
          if (!roleId || !serverId || role.isBanned || seen[id]) return;
          seen[id] = true;
          result.push({ id: id, uid: text(binding.uid), roleId: roleId, serverId: serverId,
            name: text(role.nickname || binding.nickName || '管理员').slice(0, 60),
            server: role.serverName === 'China' ? '国服' : text(role.serverName || binding.channelName || '国服').slice(0, 40),
            level: finiteValue(role.level), isDefault: !!role.isDefault });
        });
      });
    });
    return result;
  }
  function normalizeDetail(data, role, now) {
    var detail = data && data.detail;
    var dungeon = detail && detail.dungeon;
    var current = dungeon && finiteValue(dungeon.curStamina);
    var max = dungeon && finiteValue(dungeon.maxStamina);
    if (current === null || current === undefined || current < 0 || max === null || max === undefined || max <= 0) {
      throw failure('DATA', '森空岛没有返回体力数据，请确认角色资料已同步并检查数据展示设置。');
    }
    var updatedAt = epoch(detail.currentTs) || now || Date.now();
    var recoveryAt = epoch(dungeon.maxTs);
    var base = detail.base || {};
    var playerName = text(base.name || role.name || '管理员');
    var bindingName = text(role.name);
    // A game nickname contains its own #short-ID; roleId and binding.uid are different identities.
    var suffixAt = bindingName.lastIndexOf('#');
    if (playerName.indexOf('#') < 0 && suffixAt > 0 && bindingName.slice(0, suffixAt) === playerName) playerName = bindingName;
    var characters = [];
    var seen = {};
    (Array.isArray(detail.chars) ? detail.chars : []).forEach(function (entry) {
      var character = record(record(entry).charData);
      var id = text(character.id);
      var url = text(character.illustrationUrl);
      if (!id || seen[id] || !/^https:\/\/[^\s]+$/i.test(url)) return;
      seen[id] = true;
      characters.push({ id: id, name: text(character.name).slice(0, 60), url: url });
    });
    return {
      stamina: { current: current, max: max, updatedAt: updatedAt,
        recoveryAt: current >= max ? null : recoveryAt, secondsPerPoint: null },
      profile: { name: playerName.slice(0, 60),
        level: finiteValue(base.level), server: text(base.serverName || role.server || '国服').replace(/^China$/, '国服').slice(0, 40) },
      characters: characters,
      dashboard: normalizeDashboard(detail)
    };
  }
  function signedHeaders(auth, path, query, timestamp) {
    if (!root.CryptoJS || !root.CryptoJS.HmacSHA256 || !root.CryptoJS.MD5) {
      throw failure('RUNTIME', '签名组件未加载，请重新安装完整模块。');
    }
    // Header insertion order and the exact encoded query bytes are part of the protocol.
    var signed = { platform: '', timestamp: String(timestamp), dId: '', vName: '' };
    var input = path + (query || '') + signed.timestamp + JSON.stringify(signed);
    var hash = root.CryptoJS.HmacSHA256(input, auth.signToken).toString();
    return { cred: auth.cred, sign: root.CryptoJS.MD5(hash).toString(),
      platform: signed.platform, timestamp: signed.timestamp, dId: signed.dId, vName: signed.vName,
      'User-Agent': USER_AGENT, Accept: 'application/json' };
  }
  function create(bridge) {
    var clockOffset = 0;
    async function request(url, options, label, envelope) {
      var res;
      try {
        res = await bridge.net.request(Object.assign({ url: url, method: 'GET', responseType: 'text',
          redirect: 'manual', timeoutMs: 8000, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, options || {}));
      } catch (error) {
        if (error && error.code === 'TIMEOUT') throw failure('TIMEOUT', label + '超时，结果未知，请稍后手动刷新。');
        throw failure('NETWORK', label + '未完成，请检查网络后重试。');
      }
      // Never forward a response body, credential-bearing URL, or backend error text to the UI/logs.
      if (!res || res.status < 200 || res.status >= 300) {
        var status = res && Number(res.status);
        throw failure(status === 401 || status === 403 ? 'AUTH' : 'HTTP',
          label + (status === 401 || status === 403 ? '被拒绝，请重新连接森空岛。' : '失败，请稍后重试。'));
      }
      var dateHeader = res.headers && res.headers.date;
      var serverTime = Date.parse(Array.isArray(dateHeader) ? dateHeader[0] : dateHeader);
      if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
      var body;
      try { body = JSON.parse(res.body); } catch (_) { throw failure('DATA', label + '返回格式异常，请稍后重试。'); }
      var code = body && body[envelope || 'code'];
      if (code === undefined || code === null || Number(code) !== 0) {
        var authError = Number(code) === 10000 || Number(code) === 10002;
        throw failure(authError ? 'AUTH' : 'API', authError ? '森空岛登录已失效，请重新连接。' : label + '未成功，请稍后重试或重新连接。');
      }
      if (!body.data || typeof body.data !== 'object') throw failure('DATA', label + '未返回有效数据。');
      return body.data;
    }
    async function signedGet(auth, path, query, label) {
      var stamp = Math.floor((Date.now() + clockOffset) / 1000) - 1;
      return request(ORIGIN + path + (query ? '?' + query : ''),
        { headers: signedHeaders(auth, path, query, stamp) }, label);
    }
    async function ensureUserId(auth) {
      if (auth.userId) return auth;
      var identity = await signedGet(auth, '/api/v1/user/teenager', '', '获取森空岛身份');
      auth.userId = text(identity.teenager && identity.teenager.userId);
      if (!auth.userId) throw failure('DATA', '森空岛未返回账号身份，请重新连接。');
      return auth;
    }
    async function exchange(accountToken) {
      var grant = await request('https://as.hypergryph.com/user/oauth2/v2/grant', {
        method: 'POST', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ appCode: '4ca99fa6b56cc2ba', token: accountToken, type: 0 })
      }, '验证通行证', 'status');
      if (!grant.code) throw failure('AUTH', '通行证未返回授权信息，请重新获取 Token。');
      var data = await request(ORIGIN + '/api/v1/user/auth/generate_cred_by_code', {
        method: 'POST', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: grant.code, kind: 1 })
      }, '连接森空岛');
      if (!data.cred || !data.token) throw failure('AUTH', '森空岛未返回完整登录信息，请重新连接。');
      return ensureUserId({ accountToken: accountToken, cred: text(data.cred), signToken: text(data.token), userId: text(data.userId) });
    }
    async function connect(input) {
      var auth = await exchange(parseAccountToken(input));
      var data = await signedGet(auth, '/api/v1/game/player/binding', '', '读取绑定角色');
      return { auth: auth, roles: parseRoles(data) };
    }
    async function refreshAuth(saved) {
      if (!saved || !saved.cred) throw failure('AUTH', '请先连接森空岛账号。');
      var auth = Object.assign({}, saved);
      try {
        var data = await request(ORIGIN + '/api/v1/auth/refresh', {
          headers: { cred: auth.cred, 'User-Agent': USER_AGENT, Accept: 'application/json' }
        }, '刷新森空岛登录');
        if (!data.token) throw failure('DATA', '森空岛未返回签名凭据，请重新连接。');
        auth.signToken = text(data.token);
      } catch (error) {
        // Only an explicit authentication rejection permits a new exchange. Never retry timeouts.
        if (error.code !== 'AUTH' || !auth.accountToken) throw error;
        return exchange(auth.accountToken);
      }
      return ensureUserId(auth);
    }
    async function fetchStamina(saved, role) {
      if (!role || !role.roleId || !role.serverId) throw failure('INPUT', '请先选择终末地角色。');
      var auth = await refreshAuth(saved);
      var query = 'roleId=' + encodeURIComponent(role.roleId) + '&serverId=' + encodeURIComponent(role.serverId) +
        '&userId=' + encodeURIComponent(auth.userId);
      var data = await signedGet(auth, '/web/v1/game/endfield/card/detail', query, '同步终末地体力');
      var result = normalizeDetail(data, role, Date.now());
      result.auth = auth;
      return result;
    }
    return { connect: connect, fetchStamina: fetchStamina };
  }
  root.EndfieldAPI = { create: create, parseAccountToken: parseAccountToken,
    parseRoles: parseRoles, normalizeDetail: normalizeDetail, signedHeaders: signedHeaders };
})(typeof window !== 'undefined' ? window : globalThis);

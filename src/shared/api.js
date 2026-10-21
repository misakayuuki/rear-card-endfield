(function (root) {
  'use strict';
  var ORIGIN = 'https://zonai.skland.com';
  var USER_AGENT = 'Skland/1.32.1 (com.hypergryph.skland; build:103201004; Android 33; ) Okhttp/4.11.0';

  function failure(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }
  function responseTurn() {
    // The rear host drains resolved Promises within its current execution budget.
    // Resolve from a frame callback so the remaining work runs in the next frame.
    return new Promise(function (resolve) {
      if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(function () { resolve(); });
      else root.setTimeout(resolve, 0);
    });
  }
  async function responseText(response) {
    try {
    var headers = response.headers || {};
    var coding = headers['content-encoding'] || headers['Content-Encoding'] || '';
    coding = String(Array.isArray(coding) ? coding.join(',') : coding).trim().toLowerCase();
    if (coding && coding !== 'identity' && coding !== 'gzip') throw new Error('Unsupported response encoding');
    // A plain response is also valid when the server declines gzip negotiation.
    if (typeof response.bodyBase64 !== 'string') {
      if (coding === 'gzip' || typeof response.body !== 'string') throw new Error('Missing response body');
      return response.body;
    }
    var encoded = response.bodyBase64;
    if (!encoded || encoded.length % 4 !== 0) throw new Error('Invalid response encoding');
    var padding = encoded.slice(-2) === '==' ? 2 : encoded.slice(-1) === '=' ? 1 : 0;
    var limit = 8 * 1024 * 1024;
    var length = encoded.length / 4 * 3 - padding;
    if (length > limit) throw new Error('Response too large');
    await responseTurn();
    var batchAt = Date.now();
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var alphabetCodes = new Int16Array(128);
    for (var code = 0; code < alphabetCodes.length; code++) alphabetCodes[code] = -1;
    for (var symbol = 0; symbol < alphabet.length; symbol++) alphabetCodes[alphabet.charCodeAt(symbol)] = symbol;
    var bytes = new Uint8Array(length);
    for (var start = 0, at = 0; start < encoded.length; start += 8192) {
      var end = Math.min(start + 8192, encoded.length);
      for (var i = start; i < end; i += 4) {
        var aCode = encoded.charCodeAt(i), bCode = encoded.charCodeAt(i + 1);
        var cCode = encoded.charCodeAt(i + 2), dCode = encoded.charCodeAt(i + 3);
        var a = aCode < 128 ? alphabetCodes[aCode] : -1, b = bCode < 128 ? alphabetCodes[bCode] : -1;
        var c = cCode < 128 ? alphabetCodes[cCode] : -1, d = dCode < 128 ? alphabetCodes[dCode] : -1;
        var last = i + 4 === encoded.length;
        if (a < 0 || b < 0 || (c < 0 && !(last && cCode === 61 && dCode === 61)) ||
            (d < 0 && !(last && dCode === 61))) throw new Error('Invalid response encoding');
        var bits = a << 18 | b << 12 | (c < 0 ? 0 : c) << 6 | (d < 0 ? 0 : d);
        if (at < bytes.length) bytes[at++] = bits >>> 16;
        if (at < bytes.length) bytes[at++] = bits >>> 8 & 255;
        if (at < bytes.length) bytes[at++] = bits & 255;
      }
      if (Date.now() - batchAt >= 8) { await responseTurn(); batchAt = Date.now(); }
    }
    await responseTurn();
    batchAt = Date.now();
    var pieces = [], produced = 0;
    var utf8 = new root.fflate.DecodeUTF8(function (piece) { if (piece) pieces.push(piece); });
    async function decode(chunk) {
      // Gunzip can expand a small compressed chunk into hundreds of KiB. Keep
      // UTF-8 conversion bounded as well, preserving split multibyte characters.
      for (var offset = 0; offset < chunk.length; offset += 8192) {
        utf8.push(chunk.subarray(offset, Math.min(offset + 8192, chunk.length)), false);
        if (Date.now() - batchAt >= 8) { await responseTurn(); batchAt = Date.now(); }
      }
    }
    if (coding === 'gzip') {
      if (bytes.length < 18 || bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8) throw new Error('Invalid gzip header');
      var n = bytes.length;
      var size = (bytes[n - 4] | bytes[n - 3] << 8 | bytes[n - 2] << 16 | bytes[n - 1] << 24) >>> 0;
      if (!size || size > limit) throw new Error('Response too large');
      var pending = [], finished = false;
      var gzip = new root.fflate.Gunzip(function (chunk, final) {
        produced += chunk.length;
        // Check actual output too: an untrusted gzip trailer may understate it.
        if (produced > limit) throw new Error('Response too large');
        if (chunk.length) pending.push(chunk);
        if (final) finished = true;
      });
      for (var compressedAt = 0; compressedAt < bytes.length; compressedAt += 512) {
        var compressedEnd = Math.min(compressedAt + 512, bytes.length);
        gzip.push(bytes.subarray(compressedAt, compressedEnd), compressedEnd === bytes.length);
        if (Date.now() - batchAt >= 8) { await responseTurn(); batchAt = Date.now(); }
        for (var part = 0; part < pending.length; part++) await decode(pending[part]);
        pending.length = 0;
      }
      if (!finished || produced !== size) throw new Error('Incomplete response');
    } else {
      await decode(bytes);
    }
    await responseTurn();
    utf8.push(new Uint8Array(0), true);
    await responseTurn();
    return pieces.join('');
    } finally {
      // Streaming callbacks close over this async frame. Release their large
      // buffers on success and failure before the next snapshot is prepared.
      response = null; encoded = null; bytes = null; pieces = null;
      pending = null; gzip = null; utf8 = null;
    }
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
  function imageUrl(value) {
    return typeof value === 'string' && value.length <= 2048 && /^https:\/\/[^\s/@]+(?:\/[^\s]*)?$/i.test(value) ? value : null;
  }
  function selectedMedals(display) {
    if (!display || typeof display !== 'object' || Array.isArray(display)) return { known: false, entries: [] };
    // Both the current slot -> medal-ID map and the older single-medal schema are observed upstream.
    var single = Object.prototype.hasOwnProperty.call(display, 'achieveMedalId');
    var keys = Object.keys(display);
    if (!single && keys.some(function (key) { return !/^\d+$/.test(key); })) return { known: false, entries: [] };
    var entries = [], ids = Object.create(null), malformed = false;
    (single ? ['achieveMedalId'] : keys.sort(function (a, b) { return Number(a) - Number(b); })).forEach(function (slot) {
      var value = display[slot];
      if (value === null || value === undefined || value === '') return;
      if (typeof value !== 'string' || value.length > 80) { malformed = true; return; }
      if (!value.trim()) return;
      var id = value.trim();
      if (ids[id]) return;
      ids[id] = true;
      entries.push({ id: id, slot: single ? '1' : slot });
    });
    return malformed ? { known: false, entries: [] } : { known: true, entries: entries };
  }
  function medalIcon(data, level, plated) {
    var options = [level >= 3 && data.reforge3Icon, level >= 2 && data.reforge2Icon,
      plated === true && data.platedIcon, data.initIcon];
    for (var i = 0; i < options.length; i++) { var url = imageUrl(options[i]); if (url) return url; }
    return null;
  }
  function normalizeDashboard(detail) {
    var source = record(detail.achieve);
    var medals = Array.isArray(source.achieveMedals) ? source.achieveMedals : [];
    var chars = Array.isArray(detail.chars) ? detail.chars : [];
    var selection = selectedMedals(source.display);
    var dashboard = { glory: null, operatorCount: count(record(detail.base).charNum), operators: [],
      operatorsTruncated: chars.length > 64, medalsTruncated: selection.entries.length > 32 };
    // achieveMedals is the catalogue returned for this account; only display selects the showcase.
    if (Object.keys(source).length) {
      dashboard.glory = { count: count(source.count), displayKnown: selection.known,
        displayCount: selection.known ? selection.entries.length : null, medals: [] };
      var medalMap = Object.create(null);
      medals.forEach(function (value) {
        var medal = record(value), data = record(medal.achievementData);
        var id = label(data.id, 80);
        if (id && !medalMap[id]) medalMap[id] = medal;
      });
      selection.entries.slice(0, 32).forEach(function (selected) {
        var medal = record(medalMap[selected.id]), data = record(medal.achievementData);
        var level = count(medal.level), plated = typeof medal.isPlated === 'boolean' ? medal.isPlated : null;
        dashboard.glory.medals.push({ id: selected.id, name: label(data.name), category: label(data.cateName),
          level: level, isPlated: plated, iconUrl: medalIcon(data, level, plated), slot: selected.slot });
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
  function normalizeDetail(data, role, now, staminaOnly) {
    var detail = data && data.detail;
    var dungeon = detail && detail.dungeon;
    var current = dungeon && finiteValue(dungeon.curStamina);
    var max = dungeon && finiteValue(dungeon.maxStamina);
    if (current === null || current === undefined || current < 0 || max === null || max === undefined || max <= 0) {
      throw failure('DATA', '森空岛没有返回体力数据，请确认角色资料已同步并检查数据展示设置。');
    }
    var updatedAt = epoch(detail.currentTs) || now || Date.now();
    var recoveryAt = epoch(dungeon.maxTs);
    var stamina = { current: current, max: max, updatedAt: updatedAt,
      recoveryAt: current >= max ? null : recoveryAt, secondsPerPoint: null };
    if (staminaOnly) return { stamina: stamina };
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
      stamina: stamina,
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
  function create(bridge, settings) {
    var clockOffset = 0;
    var compressed = !!(settings && settings.compressed);
    var trace = settings && typeof settings.trace === 'function' ? settings.trace : function () {};
    async function request(url, options, label, envelope, compactResponse) {
      var res;
      var args = Object.assign({ url: url, method: 'GET', responseType: 'text',
        redirect: 'manual', timeoutMs: 8000, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, options || {});
      if (compactResponse) {
        if (!root.fflate || typeof root.fflate.Gunzip !== 'function' || typeof root.fflate.DecodeUTF8 !== 'function' ||
            (typeof root.requestAnimationFrame !== 'function' && typeof root.setTimeout !== 'function')) {
          throw failure('RUNTIME', '数据解压组件未加载，请重新安装完整模块。');
        }
        // Explicit Accept-Encoding leaves compressed bytes intact in Android's HttpURLConnection.
        // Decode only after the small base64 payload has crossed the rear screen HostVar bridge.
        args.responseType = 'base64';
        args.headers = Object.assign({}, args.headers, { 'Accept-Encoding': 'gzip' });
      }
      try {
        trace(compactResponse ? 'detail.request' : 'auth.request');
        res = await bridge.net.request(args);
        trace(compactResponse ? 'detail.reply' : 'auth.reply', res && typeof res.bodyBase64 === 'string' ? res.bodyBase64.length : res && typeof res.body === 'string' ? res.body.length : 0);
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
      try {
        var source = compactResponse ? await responseText(res) : res.body;
        res = null;
        trace(compactResponse ? 'detail.decoded' : 'auth.decoded', typeof source === 'string' ? source.length : 0);
        // Joining text and parsing JSON each receive their own host time budget.
        if (compactResponse) await responseTurn();
        body = JSON.parse(source);
        source = null;
        trace(compactResponse ? 'detail.parsed' : 'auth.parsed');
        if (compactResponse) await responseTurn();
      } catch (_) { throw failure('DATA', label + '返回格式异常，请稍后重试。'); }
      finally { source = null; res = null; }
      var code = body && body[envelope || 'code'];
      if (code === undefined || code === null || Number(code) !== 0) {
        var authError = Number(code) === 10000 || Number(code) === 10002;
        throw failure(authError ? 'AUTH' : 'API', authError ? '森空岛登录已失效，请重新连接。' : label + '未成功，请稍后重试或重新连接。');
      }
      if (!body.data || typeof body.data !== 'object') throw failure('DATA', label + '未返回有效数据。');
      return body.data;
    }
    async function signedGet(auth, path, query, label, compactResponse) {
      var stamp = Math.floor((Date.now() + clockOffset) / 1000) - 1;
      return request(ORIGIN + path + (query ? '?' + query : ''),
        { headers: signedHeaders(auth, path, query, stamp) }, label, undefined, compactResponse);
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
      var data = await signedGet(auth, '/web/v1/game/endfield/card/detail', query, '同步终末地体力', compressed);
      try {
        var result = normalizeDetail(data, role, Date.now(), !!(settings && settings.staminaOnly));
        result.auth = auth;
        return result;
      } finally {
        // Only scalar stamina values leave this path. Resolved host Promises may
        // still own this private JSON object, so detach its large detail graph
        // before clearing our local reference. Full settings sync is unchanged.
        if (settings && settings.staminaOnly && data && typeof data === 'object') {
          Object.keys(data).forEach(function (key) { delete data[key]; });
        }
        data = null;
      }
    }
    return { connect: connect, fetchStamina: fetchStamina };
  }
  root.EndfieldAPI = { create: create, parseAccountToken: parseAccountToken,
    parseRoles: parseRoles, normalizeDetail: normalizeDetail, signedHeaders: signedHeaders };
})(typeof window !== 'undefined' ? window : globalThis);

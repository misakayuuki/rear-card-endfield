(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var previewMode = !window.bridge;
  var service = !previewMode && window.EndfieldService ? window.EndfieldService.create(window.bridge) : null;
  var defaults = { accent: '#E5F56A', safeLeft: 336, characterName: '', fit: 'cover', portraitPositionX: 50, portraitPositionY: 40, portraitScale: 1.2, refreshMinutes: 15 };
  var settings = Object.assign({}, defaults);
  var snapshot = null;
  var roles = [];
  var characters = [];
  var pendingPortrait;
  var busy = false;
  var imageJob = 0;
  var imageProcessing = false;
  var feedbackTimer = null;
  var dirty = false;
  var previewFrame = $('native-preview');
  var latestPreview = null;
  var previewOrigin = window.location.origin;
  function sendPreview() {
    if (latestPreview && previewFrame.contentWindow) previewFrame.contentWindow.postMessage({ type: 'endfield:preview', snapshot: latestPreview }, previewOrigin === 'null' ? '*' : previewOrigin);
  }
  window.EndfieldSettingsPreview = { update: function (value) { latestPreview = value; sendPreview(); } };
  previewFrame.addEventListener('load', sendPreview);
  window.addEventListener('message', function (event) {
    if (event.source !== previewFrame.contentWindow || event.origin !== previewOrigin) return;
    if (event.data && event.data.type === 'endfield:preview:ready') sendPreview();
  });

  function feedback(message, isError) {
    clearTimeout(feedbackTimer);
    $('feedback').textContent = message;
    $('feedback').classList.toggle('error', !!isError);
    $('feedback').hidden = false;
    if (!isError) feedbackTimer = setTimeout(function () { $('feedback').hidden = true; }, 6000);
  }
  function currentPortrait() {
    return pendingPortrait !== undefined ? pendingPortrait : snapshot && snapshot.portrait && snapshot.portrait.dataUrl;
  }
  function updateImageControls() {
    $('save-button').disabled = busy || imageProcessing;
    $('reduce-image').disabled = busy || imageProcessing || !currentPortrait();
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    var disabledBefore = new Set();
    document.querySelectorAll('button,input,select').forEach(function (control) { if (control.disabled) disabledBefore.add(control); control.disabled = true; });
    try { await fn(); }
    catch (error) { feedback(error && error.message ? error.message : '操作未完成，请稍后再试。', true); }
    finally {
      busy = false;
      document.querySelectorAll('button,input,select').forEach(function (control) { control.disabled = disabledBefore.has(control); });
      updateImageControls();
      $('choose-character').disabled = !characters.length;
      $('character-select').disabled = !characters.length;
    }
  }
  function readForm() {
    return Object.assign({}, settings, {
      accent: $('accent-color').value.toUpperCase(), safeLeft: Number($('safe-left').value),
      characterName: $('character-name').value.trim().slice(0, 24), fit: $('portrait-fit').value,
      portraitPositionX: Number($('portrait-x').value), portraitPositionY: Number($('portrait-y').value),
      portraitScale: Number($('portrait-scale').value),
      refreshMinutes: Number($('refresh-minutes').value)
    });
  }
  function fillForm() {
    $('accent-color').value = settings.accent;
    $('safe-left').value = settings.safeLeft;
    $('character-name').value = settings.characterName;
    $('portrait-fit').value = settings.fit;
    $('portrait-x').value = settings.portraitPositionX;
    $('portrait-y').value = settings.portraitPositionY;
    $('portrait-scale').value = settings.portraitScale;
    $('refresh-minutes').value = String(settings.refreshMinutes);
    if (!$('refresh-minutes').value) $('refresh-minutes').value = '15';
    renderPreview();
  }
  function shortTime(value) {
    if (!value || !Number.isFinite(Number(value))) return '尚未同步';
    var date = new Date(Number(value));
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }
  function duration(value) {
    if (window.EndfieldCore && window.EndfieldCore.formatDuration) return window.EndfieldCore.formatDuration(value);
    var minutes = Math.max(0, Math.ceil(value / 60000));
    return Math.floor(minutes / 60) + '小时 ' + (minutes % 60) + '分';
  }
  function derive(stamina) {
    if (!stamina) return null;
    if (window.EndfieldCore && window.EndfieldCore.deriveStamina) return window.EndfieldCore.deriveStamina(stamina, Date.now());
    return { current: stamina.current, max: stamina.max, full: stamina.current >= stamina.max, remainingMs: Math.max(0, stamina.recoveryAt - Date.now()), estimated: false, stale: false };
  }
  function renderPreview() {
    var draft = readForm();
    document.documentElement.style.setProperty('--accent', draft.accent);
    $('accent-value').textContent = draft.accent;
    $('portrait-x-value').textContent = draft.portraitPositionX + '%';
    $('portrait-y-value').textContent = draft.portraitPositionY + '%';
    $('portrait-scale-value').textContent = Math.round(draft.portraitScale * 100) + '%';
    $('safe-left-value').textContent = draft.safeLeft;
    $('preview-safe').style.left = Math.max(3.8, draft.safeLeft / 912 * 100) + '%';
    var dataUrl = currentPortrait();
    var img = $('portrait-preview');
    if (dataUrl) {
      if (img.getAttribute('src') !== dataUrl) img.src = dataUrl;
      img.hidden = false;
      img.style.objectFit = draft.fit;
      img.style.objectPosition = draft.portraitPositionX + '% ' + draft.portraitPositionY + '%';
      img.style.transform = 'scale(' + draft.portraitScale + ')';
      img.style.transformOrigin = draft.portraitPositionX + '% ' + draft.portraitPositionY + '%';
    } else { img.hidden = true; img.removeAttribute('src'); }
    $('art-placeholder').hidden = !!dataUrl;
    $('remove-image').hidden = !dataUrl;
    updateImageControls();
    $('upload-label').textContent = dataUrl ? '更换本地角色立绘' : '选择本地角色立绘';
    $('preview-character').textContent = draft.characterName || '你的干员';
    $('preview-label').textContent = dirty ? '有未保存的调整' : previewMode ? '示例数据' : snapshot && snapshot.stamina ? '已应用' : '等待配置';
    var stamina = derive(snapshot && snapshot.stamina);
    $('stamina-current').textContent = stamina ? stamina.current : '—';
    $('stamina-max').textContent = stamina ? stamina.max : '—';
    $('stamina-fill').style.width = stamina ? Math.max(0, Math.min(100, stamina.current / stamina.max * 100)) + '%' : '0%';
    var recoveryText = '连接账号后显示恢复进度';
    if (stamina) {
      recoveryText = stamina.full ? '体力已回满' : stamina.remainingMs === null ? '恢复时间待同步' : stamina.remainingMs === 0 ? '预计已回满 · 待同步' : '约 ' + duration(stamina.remainingMs) + ' 后回满';
      recoveryText += stamina.stale ? ' · 数据较旧' : stamina.estimated ? ' · 估算' : '';
    }
    $('stamina-time').textContent = recoveryText;
    var profile = snapshot && snapshot.profile;
    $('preview-profile').textContent = profile && profile.name ? profile.name + (profile.level ? ' / Lv.' + profile.level : '') : '等待连接森空岛';
    $('preview-sync').textContent = snapshot && snapshot.syncedAt ? shortTime(snapshot.syncedAt) + ' 更新' : '尚未同步';
    var detailsTime = snapshot && (snapshot.detailsSyncedAt === undefined ? snapshot.syncedAt : snapshot.detailsSyncedAt);
    $('sync-status').textContent = previewMode ? '浏览器中的示例数据' : snapshot && snapshot.error ? snapshot.error : snapshot && snapshot.syncedAt ? '理智 ' + shortTime(snapshot.syncedAt) + ' · 资料 ' + (detailsTime ? shortTime(detailsTime) : '未同步') : '尚未连接账号';
    $('save-hint').textContent = dirty ? '有未保存的调整' : previewMode ? '预览修改仅保留在当前页面' : '调整后保存，即可应用到背屏';
    if (window.EndfieldSettingsPreview && typeof window.EndfieldSettingsPreview.update === 'function') {
      window.EndfieldSettingsPreview.update(Object.assign({ schemaVersion: 1, stamina: null, profile: null, dashboard: null, syncedAt: 0, error: null }, snapshot || {}, { settings: draft, portrait: dataUrl ? { dataUrl: dataUrl } : null }));
    }
  }
  function renderAccount() {
    var profile = snapshot && snapshot.profile;
    var connected = !!(profile && profile.name) && !previewMode;
    $('account-connected').hidden = !connected;
    $('account-badge').textContent = previewMode ? '预览模式' : connected ? '已连接' : roles.length ? '请选择角色' : '未连接';
    $('account-badge').classList.toggle('connected', connected);
    if (connected) {
      $('account-name').textContent = profile.name;
      $('account-server').textContent = profile.server || '国服';
      $('login-details').open = false;
    }
    $('role-picker').hidden = !roles.length;
    var select = $('role-select');
    var previous = select.value;
    select.textContent = '';
    roles.forEach(function (role, index) { var option = document.createElement('option'); option.value = String(index); option.textContent = (role.name || '未命名角色') + ' · ' + (role.server || '国服'); select.appendChild(option); });
    if (previous && select.options[Number(previous)]) select.value = previous;
  }
  async function loadCharacters() {
    characters = service && service.getCharacters ? await service.getCharacters() : [];
    var select = $('character-select');
    var previous = select.value;
    select.textContent = '';
    if (!characters.length) {
      var empty = document.createElement('option');
      empty.textContent = snapshot && snapshot.stamina && !previewMode ? '暂无可用的角色立绘' : '同步全部资料后显示';
      select.appendChild(empty);
    } else {
      characters.forEach(function (character) { var option = document.createElement('option'); option.value = character.id; option.textContent = character.name; select.appendChild(option); });
      if (characters.some(function (character) { return character.id === previous; })) select.value = previous;
    }
    $('owned-help').textContent = characters.length ? '森空岛返回了 ' + characters.length + ' 位展示干员；立绘仅在你选择并保存时更换。' : '可选范围以森空岛返回的干员为准，也可以上传本地图片；立绘不会随刷新更换。';
    select.disabled = busy || !characters.length;
    $('choose-character').disabled = busy || !characters.length;
  }
  function markDirty() { dirty = true; renderPreview(); }
  function parseToken(input) {
    var value = input.trim();
    if (!value) throw new Error('请先粘贴森空岛账号令牌。');
    if (value[0] === '{') {
      var parsed;
      try { parsed = JSON.parse(value); } catch (error) { throw new Error('JSON 内容不完整，请重新复制令牌页面内容。'); }
      value = parsed.data && parsed.data.content || parsed.data && parsed.data.token || parsed.token || '';
      if (typeof value !== 'string' || !value.trim()) throw new Error('返回内容中未找到 token，请先确认已登录森空岛。');
    }
    value = value.trim().replace(/^"|"$/g, '');
    if (value.length > 8192 || /\s/.test(value)) throw new Error('令牌格式不正确，请复制完整的 token 值。');
    return value;
  }
  $('connect-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (previewMode) { $('account-token').value = ''; feedback('请在卡片桥内打开模块设置，再连接真实账号。', true); return; }
    action(async function () {
      var token;
      try { token = parseToken($('account-token').value); }
      finally { $('account-token').value = ''; }
      try { roles = await service.connect(token); }
      finally { token = null; }
      if (!roles || !roles.length) throw new Error('此账号没有可用的终末地角色，请先在森空岛绑定游戏角色。');
      try {
        if (roles.length === 1) { snapshot = await service.selectRole(roles[0]); feedback('已连接账号并同步数据。'); }
        else feedback('账号已连接，请选择要显示的游戏角色。');
      } finally { snapshot = await service.getSnapshot(); await loadCharacters(); renderAccount(); renderPreview(); }
    });
  });
  $('select-role-button').addEventListener('click', function () {
    action(async function () {
      var role = roles[Number($('role-select').value)]; if (!role) throw new Error('请先选择一个游戏角色。');
      try { snapshot = await service.selectRole(role); feedback('已切换游戏角色并同步数据。'); }
      finally { snapshot = await service.getSnapshot(); await loadCharacters(); renderAccount(); renderPreview(); }
    });
  });
  $('disconnect-button').addEventListener('click', function () {
    action(async function () { await service.disconnect(); roles = []; snapshot = await service.getSnapshot(); await loadCharacters(); $('login-details').open = true; renderAccount(); renderPreview(); feedback('已移除本机模块保存的登录凭据。'); });
  });
  $('refresh-button').addEventListener('click', function () {
    if (previewMode) { feedback('这里显示示例数据；安装模块并连接账号后可手动同步全部资料。'); return; }
    action(async function () {
      $('refresh-button').textContent = '同步中…';
      try { snapshot = await service.refresh(); feedback(snapshot && snapshot.stamina ? '全部资料已同步，立绘保持你的选择。' : '请先连接森空岛账号。'); }
      finally { $('refresh-button').textContent = '同步全部资料'; snapshot = await service.getSnapshot(); await loadCharacters(); renderAccount(); renderPreview(); }
    });
  });
  $('appearance-form').addEventListener('input', markDirty);
  $('appearance-form').addEventListener('change', function (event) { if (event.target !== $('portrait-file')) markDirty(); });
  $('reset-portrait-layout').addEventListener('click', function () {
    $('portrait-fit').value = defaults.fit;
    $('portrait-scale').value = defaults.portraitScale;
    $('portrait-x').value = defaults.portraitPositionX;
    $('portrait-y').value = defaults.portraitPositionY;
    markDirty();
  });
  document.querySelectorAll('[data-color]').forEach(function (button) { button.addEventListener('click', function () { $('accent-color').value = button.getAttribute('data-color'); markDirty(); }); });
  $('remove-image').addEventListener('click', function () { if (busy) return; imageJob += 1; imageProcessing = false; pendingPortrait = ''; $('portrait-file').value = ''; $('image-status').textContent = '保存后移除当前立绘'; markDirty(); });

  $('portrait-file').addEventListener('change', async function () {
    var file = $('portrait-file').files && $('portrait-file').files[0];
    if (!file || busy) return;
    var job = ++imageJob;
    imageProcessing = true;
    $('image-status').textContent = '正在为背屏处理图片…';
    updateImageControls();
    try {
      var prepared = await window.EndfieldImages.prepare(file);
      if (job !== imageJob) return;
      pendingPortrait = prepared.dataUrl;
      $('image-status').textContent = prepared.width + ' × ' + prepared.height + ' · ' + Math.round(prepared.bytes / 1024) + ' KB · 等待保存';
      markDirty();
    } catch (error) { if (job === imageJob) { $('image-status').textContent = '处理失败，当前立绘未改变'; feedback(error.message, true); } }
    finally { if (job === imageJob) { imageProcessing = false; updateImageControls(); } }
  });
  $('reduce-image').addEventListener('click', async function () {
    if (busy || imageProcessing) return;
    var dataUrl = currentPortrait();
    if (!dataUrl) { feedback('请先选择一张立绘。'); return; }
    var job = ++imageJob;
    imageProcessing = true;
    updateImageControls();
    $('image-status').textContent = '正在本地降低立绘占用…';
    try {
      var prepared = await window.EndfieldImages.prepare(window.EndfieldImages.fromDataUrl(dataUrl), { maxDimension: 1280, maxChars: 320000 });
      if (job !== imageJob) return;
      pendingPortrait = prepared.dataUrl;
      $('image-status').textContent = prepared.width + ' × ' + prepared.height + ' · ' + Math.round(prepared.bytes / 1024) + ' KB · 降低占用后等待保存';
      markDirty();
      feedback('立绘已在本地缩小，请检查预览后点击保存。');
    } catch (error) { if (job === imageJob) { $('image-status').textContent = '处理失败，当前立绘未改变'; feedback(error.message, true); } }
    finally { if (job === imageJob) { imageProcessing = false; updateImageControls(); } }
  });
  $('choose-character').addEventListener('click', function () {
    action(async function () {
      var character = characters.find(function (item) { return item.id === $('character-select').value; });
      if (!character) throw new Error('请选择一位已拥有的干员。');
      var job = ++imageJob;
      imageProcessing = true;
      $('image-status').textContent = '正在下载并处理所选立绘…';
      try {
        var dataUrl = await service.downloadPortrait(character.id);
        if (job !== imageJob) return;
        var prepared = await window.EndfieldImages.prepare(window.EndfieldImages.fromDataUrl(dataUrl));
        if (job !== imageJob) return;
        pendingPortrait = prepared.dataUrl;
        $('character-name').value = character.name.slice(0, 24);
        $('image-status').textContent = character.name + ' · ' + prepared.width + ' × ' + prepared.height + ' · ' + Math.round(prepared.bytes / 1024) + ' KB · 等待保存';
        markDirty();
        feedback('立绘已载入，可调整位置后保存。');
      } catch (error) { if (job === imageJob) $('image-status').textContent = '处理失败，当前立绘未改变'; throw error; }
      finally { if (job === imageJob) imageProcessing = false; }
    });
  });
  $('appearance-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (imageProcessing) { feedback('图片正在处理，请稍后保存。'); return; }
    action(async function () {
      var draft = readForm();
      var portrait = pendingPortrait;
      if (previewMode) {
        settings = draft;
        snapshot = Object.assign({}, snapshot, { settings: settings });
        if (portrait !== undefined) snapshot.portrait = portrait ? { dataUrl: portrait } : null;
      } else {
        await service.saveSettings(draft);
        if (portrait !== undefined) await service.setPortrait(portrait);
        settings = await service.getSettings();
        snapshot = await service.getSnapshot();
      }
      pendingPortrait = undefined; dirty = false;
      $('image-status').textContent = snapshot && snapshot.portrait && snapshot.portrait.dataUrl ? '立绘已保存，可在息屏快照中显示' : '保留最高 1600 像素长边，优先使用高清 WebP';
      fillForm();
      feedback(previewMode ? '预览已更新。安装模块后即可保存到背屏。' : '已保存并通知背屏更新。');
    });
  });
  async function init() {
    $('preview-banner').hidden = !previewMode;
    if (previewMode) {
      var now = Date.now();
      snapshot = { schemaVersion: 1, settings: settings, stamina: { current: 168, max: 240, updatedAt: now, recoveryAt: now + 432 * 60000, secondsPerPoint: 360 }, profile: { name: '管理员#1234', level: 45, server: '国服' }, syncedAt: now, portrait: null, error: null };
      snapshot.dashboard = {
        glory: { count: 28, displayKnown: true, displayCount: 2, medals: [
          { id: 'demo-medal-1', name: '展示蚀刻章 · 示例一', category: '探索', level: 1, isPlated: false, iconDataUrl: null },
          { id: 'demo-medal-2', name: '展示蚀刻章 · 示例二', category: '挑战', level: 2, isPlated: true, iconDataUrl: null }
        ] },
        operatorCount: 18, operators: [
          { id: 'demo-operator-1', name: '演示干员 A', level: 60, evolvePhase: 2, potentialLevel: 0, rarity: '6',
            weapon: { name: '演示武器 A', level: 60, refineLevel: 0, breakthroughLevel: 2 },
            skills: [{ id: 'demo-skill-1', name: '演示战技', level: 6 }, { id: 'demo-skill-2', name: '演示终结技', level: 6 }],
            equipment: [{ slot: 'bodyEquip', name: '演示护具', level: '50' }, { slot: 'armEquip', name: '演示臂甲', level: '50' }] },
          { id: 'demo-operator-2', name: '演示干员 B', level: 45, evolvePhase: 1, potentialLevel: 2, rarity: '5',
            weapon: { name: '演示武器 B', level: 40, refineLevel: 1, breakthroughLevel: 1 },
            skills: [{ id: 'demo-skill-3', name: '演示战技', level: 4 }], equipment: [] }
        ], operatorsTruncated: false, medalsTruncated: false
      };
      $('account-token').disabled = true;
      $('account-token').placeholder = '请在卡片桥内连接真实账号';
    } else {
      if (!service) throw new Error('模块组件未能加载，请重新安装完整模块 ZIP。');
      settings = Object.assign({}, defaults, await service.getSettings());
      snapshot = await service.getSnapshot();
      if (service.getRoles) roles = await service.getRoles();
    }
    await loadCharacters(); fillForm(); renderAccount(); renderPreview();
  }
  init().catch(function (error) { feedback(error.message || '设置加载失败，请重新打开模块。', true); });
  window.addEventListener('pagehide', function () { $('account-token').value = ''; });
  setInterval(function () { if (!document.hidden) renderPreview(); }, 60000);
})();

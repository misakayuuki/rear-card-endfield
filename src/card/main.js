(function () {
  'use strict';

  // Own the previous instance explicitly: bridge callbacks have no unsubscribe API.
  if (typeof window.__endfieldCardStop === 'function') window.__endfieldCardStop();
  var canvas = document.getElementById('rear');
  var ctx = canvas.getContext('2d');
  var core = window.EndfieldCore;
  var nativeBridge = typeof bridge !== 'undefined' ? bridge : null;
  var service = nativeBridge && window.EndfieldService ? window.EndfieldService.create(nativeBridge, { card: true }) : null;
  var W = Number(window.CANVAS_W) || 912;
  var H = Number(window.CANVAS_H) || 596;
  var stopped = false;
  var queued = false;
  var frameId = null;
  var timerId = null;
  var refreshTimerId = null;
  var refreshRevision = 0;
  var busy = false;
  var lastAttemptAt = 0;
  var loadRevision = 0;
  var pointer = null;
  var portraitImage = null;
  var portraitSource = '';
  var imageFailed = false;
  var medalImages = Object.create(null);
  var state = { schemaVersion: 1, settings: {}, stamina: null, profile: null, portrait: null, syncedAt: 0, error: null };
  var refreshHit = { x: 720, y: 518, w: 156, h: 54 };
  var page = 0;
  var operatorIndex = 0;
  var medalPage = 0;
  var operatorEquipment = false;
  var skillPage = 0;
  var actions = [];
  var pageNames = ['体力总览', '光荣之路', '干员养成'];

  function settings() { return core.sanitizeSettings(state.settings || {}); }

  function requestDraw() {
    if (stopped || queued) return;
    queued = true;
    frameId = window.requestAnimationFrame(function () {
      queued = false;
      if (!stopped) draw();
    });
  }

  function acceptSnapshot(value, expanded) {
    // Service results are already validated and expanded; avoid serializing all
    // images again just to accept the same data for drawing.
    if (!expanded && window.EndfieldCache) value = window.EndfieldCache.unpack(value);
    if (stopped || !core.validSnapshot(value)) return false;
    state = value;
    updatePortrait();
    updateMedalImages();
    requestDraw();
    return true;
  }

  function updatePortrait() {
    var next = state.portrait && typeof state.portrait.dataUrl === 'string' ? state.portrait.dataUrl : '';
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(next)) next = '';
    if (next === portraitSource) return;
    if (portraitImage) { portraitImage.onload = null; portraitImage.onerror = null; }
    portraitSource = next;
    portraitImage = null;
    imageFailed = false;
    if (!next) return;
    var image = new Image();
    // Assign before src: the rear-screen host may decode a Data URL synchronously.
    portraitImage = image;
    image.onload = function () { if (!stopped && portraitImage === image) requestDraw(); };
    image.onerror = function () {
      if (stopped || portraitImage !== image) return;
      imageFailed = true;
      requestDraw();
    };
    image.src = next;
  }

  function medalSource(medal) {
    var source = medal && medal.iconDataUrl;
    return typeof source === 'string' && source.length <= 24000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source) ? source : '';
  }

  function updateMedalImages() {
    var old = medalImages, next = Object.create(null);
    Object.keys(old).forEach(function (source) { old[source].active = false; });
    var glory = state.dashboard && state.dashboard.glory;
    var medals = glory && glory.displayKnown === true && Array.isArray(glory.medals) ? glory.medals.slice(0, 32) : [];
    medals.forEach(function (medal) {
      var source = medalSource(medal);
      if (!source || next[source]) return;
      var entry = old[source];
      if (entry) { entry.active = true; next[source] = entry; return; }
      entry = { image: new Image(), failed: false, active: true };
      next[source] = entry;
      entry.image.onload = function () { if (!stopped && entry.active) requestDraw(); };
      entry.image.onerror = function () { if (!stopped && entry.active) { entry.failed = true; requestDraw(); } };
      // Prepare cached Data URLs synchronously for the first AOD draw, never fetch from Canvas.
      entry.image.src = source;
    });
    Object.keys(old).forEach(function (source) {
      if (!old[source].active) { old[source].image.onload = null; old[source].image.onerror = null; }
    });
    medalImages = next;
  }

  function text(value, x, y, size, color, weight, maxWidth) {
    ctx.fillStyle = color;
    ctx.font = (weight ? weight + ' ' : '') + size + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var label = String(value);
    if (maxWidth && ctx.measureText(label).width > maxWidth) {
      while (label.length && ctx.measureText(label + '…').width > maxWidth) label = label.slice(0, -1);
      label += '…';
    }
    ctx.fillText(label, x, y);
  }

  function line(x1, y1, x2, y2, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function clockTime(time) {
    if (!Number.isFinite(time) || time <= 0) return '--:--';
    var date = new Date(time);
    return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
  }

  function drawPlayerTitle(x, width, color) {
    var title = state.profile && state.profile.name ? String(state.profile.name) : '等待连接账号';
    var size = 32;
    ctx.font = 'bold ' + size + 'px sans-serif';
    while (size > 22 && ctx.measureText(title).width > width) {
      size -= 1;
      ctx.font = 'bold ' + size + 'px sans-serif';
    }
    // The # suffix belongs to the game's nickname. It is not the binding UID or roleId.
    var hash = title.lastIndexOf('#');
    if (hash > 0 && ctx.measureText(title).width > width) {
      var suffix = title.slice(hash), name = title.slice(0, hash);
      while (name.length > 1 && ctx.measureText(name + '…' + suffix).width > width) name = name.slice(0, -1);
      title = name + '…' + suffix;
    }
    text(title, x, 102, size, color, 'bold', width);
  }

  function drawPortrait(box, cfg) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    var iw = portraitImage && (portraitImage.naturalWidth || portraitImage.width);
    var ih = portraitImage && (portraitImage.naturalHeight || portraitImage.height);
    if (portraitImage && !imageFailed && iw > 0 && ih > 0) {
      var scale = (cfg.fit === 'contain' ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih)) * (Number(cfg.portraitScale) || 1.2);
      var dw = iw * scale;
      var dh = ih * scale;
      var px = cfg.portraitPositionX / 100;
      var py = cfg.portraitPositionY / 100;
      ctx.drawImage(portraitImage, box.x + (box.w - dw) * px, box.y + (box.h - dh) * py, dw, dh);
      // Short flat strips avoid relying on gradient support in the native Canvas.
      for (var i = 0; i < 16; i++) {
        ctx.fillStyle = 'rgba(16,19,21,' + (0.88 * Math.pow(1 - i / 16, 2)).toFixed(3) + ')';
        ctx.fillRect(box.x + i * box.w / 32, box.y, box.w / 32 + 1, box.h);
      }
      for (var j = 0; j < 14; j++) {
        ctx.fillStyle = 'rgba(16,19,21,' + (0.9 * j / 14).toFixed(3) + ')';
        ctx.fillRect(box.x, box.y + box.h - 100 + j * 100 / 14, box.w, 100 / 14 + 1);
      }
    } else {
      var cx = box.x + box.w * 0.59;
      var cy = box.y + box.h * 0.48;
      var r = Math.min(95, box.w * 0.32);
      ctx.fillStyle = '#1a2021';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      line(cx - r * 0.5, cy, cx + r * 0.5, cy, '#3c4543', 2);
      line(cx, cy - r * 0.5, cx, cy + r * 0.5, '#3c4543', 2);
    }
    ctx.restore();
  }

  function available(value) { return value === null || value === undefined || value === '' ? '--' : String(value); }

  function button(label, box, action, selected, cfg) {
    ctx.fillStyle = selected ? '#394632' : '#222c27';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    text(label, box.x + 11, box.y + box.h / 2, 17, selected ? cfg.accent : '#c4cec3', selected ? 'bold' : '', box.w - 20);
    actions.push({ box: box, run: action });
  }

  function changePage(next) {
    page = (next + pageNames.length) % pageNames.length;
    requestDraw();
  }

  function drawOverview(cfg, stamina, x, right, width) {
    var accent = cfg.accent;
    var pale = '#f3f4e9';
    var secondary = '#a4afa6';
    var hasData = !!stamina;
    text('理智', x, 193, 22, secondary, '', width * 0.44);
    var value = hasData ? String(Math.floor(stamina.current)) : '--';
    var valueSize = Math.min(106, Math.max(76, width * 0.20));
    if (value.length > 3) valueSize *= 0.78;
    text(value, x - 3, 266, valueSize, pale, 'bold', width * 0.63);
    text(hasData ? '/ ' + stamina.max : '/ --', x + 4, 331, 28, secondary, '', width * 0.4);
    var sublabel = !hasData ? '等待账号同步' : (stamina.full ? (stamina.estimated ? '预计已回满' : '理智已回满') : (stamina.estimated ? '按恢复速度估算' : '最近同步值'));
    text(sublabel, x, 374, 17, hasData && stamina.full ? accent : secondary, '', width * 0.55);
    if (!portraitImage || imageFailed) text(imageFailed ? '立绘加载失败' : '在设置中添加立绘', x + width * 0.55, 365, 15, '#707a75', '', width * 0.45);
    if (!hasData) text('在主屏设置中连接森空岛', x, 405, 17, '#9aa69d', '', width);
    else if (state.profile) text((state.profile.level !== null && state.profile.level !== undefined ? '等级 ' + state.profile.level + ' · ' : '') + (state.profile.server || '森空岛角色资料'), x, 405, 17, '#9aa69d', '', width * 0.55);
    if (cfg.characterName) text(cfg.characterName, x + width * 0.58, 405, 18, pale, 'bold', width * 0.42);
    var percentage = hasData && stamina.max > 0 ? Math.max(0, Math.min(1, stamina.current / stamina.max)) : 0;
    var bars = 18;
    var gap = 4;
    var barWidth = (width - (bars - 1) * gap) / bars;
    for (var n = 0; n < bars; n++) {
      ctx.fillStyle = n < Math.ceil(percentage * bars) ? accent : '#303833';
      ctx.fillRect(x + n * (barWidth + gap), 435, barWidth, 7);
    }
    var remaining = !hasData ? '等待同步后计算回满时间' : (stamina.full ? '理智已满，准备出发' : (stamina.remainingMs === 0 ? '预计已回满 · 待同步' : (Number.isFinite(stamina.remainingMs) ? '预计 ' + core.formatDuration(stamina.remainingMs) + '后回满' : '回满时间待同步')));
    text(remaining, x, 472, 22, pale, '', width);
  }

  function drawGlory(cfg, x, right, width) {
    var dashboard = state.dashboard || {};
    var glory = dashboard.glory;
    var known = glory && glory.displayKnown === true;
    var medals = known && Array.isArray(glory.medals) ? glory.medals.slice(0, 32) : [];
    text('森空岛展示的蚀刻章', x, 181, 18, '#c4cec3', '', width - 110);
    if (!known) {
      text('请同步蚀刻章展示信息', x, 292, 26, '#f3f4e9', 'bold', width);
      text('在设置页点「同步全部资料」读取展示栏', x, 340, 17, '#9aa69d', '', width);
      text('只显示你选中展示的蚀刻章', x, 374, 17, '#9aa69d', '', width);
      return;
    }
    if (!medals.length) {
      text(glory.displayCount > 0 ? '蚀刻章资料待同步' : '尚未设置展示蚀刻章', x, 292, 26, '#f3f4e9', 'bold', width);
      text('在森空岛设置想展示的蚀刻章', x, 340, 17, '#9aa69d', '', width);
      text('返回模块设置页同步后即可查看图案', x, 374, 17, '#9aa69d', '', width);
      return;
    }
    var pages = Math.ceil(medals.length / 6);
    medalPage = Math.min(medalPage, pages - 1);
    text('展示 ' + available(glory.displayCount) + ' 枚 · ' + (medalPage + 1) + '/' + pages + (dashboard.medalsTruncated ? ' · 部分缓存' : ''), x, 207, 15, '#9aa69d', '', width - 110);
    if (pages > 1) {
      button('‹', { x: right - 100, y: 172, w: 44, h: 36 }, function () { medalPage = (medalPage + pages - 1) % pages; requestDraw(); }, false, cfg);
      button('›', { x: right - 48, y: 172, w: 44, h: 36 }, function () { medalPage = (medalPage + 1) % pages; requestDraw(); }, false, cfg);
    }
    var gap = 10, cellWidth = (width - gap * 2) / 3;
    var iconSize = Math.min(100, cellWidth - 12);
    for (var i = 0; i < 6 && medalPage * 6 + i < medals.length; i++) {
      var medal = medals[medalPage * 6 + i];
      var left = x + (i % 3) * (cellWidth + gap), top = 222 + Math.floor(i / 3) * 136;
      ctx.fillStyle = 'rgba(26,34,31,0.82)';
      ctx.fillRect(left, top, cellWidth, 130);
      var entry = medalImages[medalSource(medal)];
      var image = entry && !entry.failed && entry.image;
      var iw = image && (image.naturalWidth || image.width), ih = image && (image.naturalHeight || image.height);
      if (iw > 0 && ih > 0) {
        var scale = Math.min(iconSize / iw, iconSize / ih), dw = iw * scale, dh = ih * scale;
        ctx.drawImage(image, left + (cellWidth - dw) / 2, top + 5 + (100 - dh) / 2, dw, dh);
      } else {
        text(entry && entry.failed ? '图案加载失败' : '待同步图案', left + 8, top + 54, 13, '#9aa69d', '', cellWidth - 16);
      }
      text(medal.name || '资料待同步', left + 8, top + 116, 15, '#f3f4e9', '', cellWidth - 16);
    }
  }

  function drawOperators(cfg, x, right, width) {
    var dashboard = state.dashboard || {};
    var operators = Array.isArray(dashboard.operators) ? dashboard.operators : [];
    if (!operators.length) {
      text('暂无干员养成数据', x, 244, 28, '#f3f4e9', 'bold', width);
      text('在设置页同步全部资料后显示养成信息', x, 295, 18, '#9aa69d', '', width);
      text('可在森空岛开启干员资料展示', x, 332, 18, '#9aa69d', '', width);
      if (dashboard.operatorCount !== null && dashboard.operatorCount !== undefined) text('已拥有 ' + dashboard.operatorCount + ' 位干员', x, 390, 23, cfg.accent, '', width);
      return;
    }
    operatorIndex = Math.min(operatorIndex, operators.length - 1);
    var operator = operators[operatorIndex];
    text(operator.name || '未命名干员', x, 189, 30, '#f3f4e9', 'bold', width - 120);
    if (operators.length > 1) {
      button('‹', { x: right - 100, y: 166, w: 44, h: 44 }, function () { operatorIndex = (operatorIndex + operators.length - 1) % operators.length; skillPage = 0; requestDraw(); }, false, cfg);
      button('›', { x: right - 48, y: 166, w: 44, h: 44 }, function () { operatorIndex = (operatorIndex + 1) % operators.length; skillPage = 0; requestDraw(); }, false, cfg);
    }
    text('Lv.' + available(operator.level), x, 232, 30, cfg.accent, 'bold', width * 0.36);
    text('晋升 ' + available(operator.evolvePhase) + ' · 潜能 ' + available(operator.potentialLevel), x + width * 0.36, 233, 17, '#c4cec3', '', width * 0.64);
    line(x, 259, right, 259, '#39403a');
    var weapon = operator.weapon;
    text(weapon ? weapon.name || '武器名称未提供' : '武器资料未提供', x, 287, 21, '#f3f4e9', 'bold', width * 0.75);
    text(weapon ? 'Lv.' + available(weapon.level) : '--', x + width * 0.79, 287, 18, cfg.accent, '', width * 0.21);
    text(weapon ? '精炼 ' + available(weapon.refineLevel) + ' · 突破 ' + available(weapon.breakthroughLevel) : '等待森空岛提供详细资料', x, 318, 16, '#9aa69d', '', width);
    line(x, 340, right, 340, '#39403a');
    button('技能', { x: x, y: 351, w: 72, h: 31 }, function () { operatorEquipment = false; requestDraw(); }, !operatorEquipment, cfg);
    button('装备', { x: x + 80, y: 351, w: 72, h: 31 }, function () { operatorEquipment = true; requestDraw(); }, operatorEquipment, cfg);
    var items = operatorEquipment ? operator.equipment : operator.skills;
    items = Array.isArray(items) ? items : [];
    var detailPages = Math.ceil(items.length / 4);
    skillPage = Math.min(skillPage, Math.max(0, detailPages - 1));
    if (!operatorEquipment && detailPages > 1) {
      button((skillPage + 1) + '/' + detailPages + ' ›', { x: right - 88, y: 351, w: 88, h: 31 }, function () { skillPage = (skillPage + 1) % detailPages; requestDraw(); }, false, cfg);
    }
    var slots = { bodyEquip: '护甲', armEquip: '护手', firstAccessory: '配件 1', secondAccessory: '配件 2' };
    if (!items.length) text(operatorEquipment ? '暂未提供装备资料' : '暂未提供技能资料', x, 429, 20, '#9aa69d', '', width);
    for (var i = 0; i < 4 && skillPage * 4 + i < items.length; i++) {
      var item = items[skillPage * 4 + i];
      var left = x + (i % 2) * (width + 12) / 2;
      var top = 402 + Math.floor(i / 2) * 49;
      var cellWidth = (width - 12) / 2;
      text(item.name || '名称未提供', left, top, 17, '#f3f4e9', '', cellWidth);
      text((operatorEquipment ? (slots[item.slot] || '装备') + ' · ' : '') + 'Lv.' + available(item.level), left, top + 21, 14, '#9aa69d', '', cellWidth);
    }
    var total = dashboard.operatorCount === null || dashboard.operatorCount === undefined ? '' : ' · 拥有 ' + dashboard.operatorCount;
    text('展示干员 ' + (operatorIndex + 1) + '/' + operators.length + total + (dashboard.operatorsTruncated ? ' · 部分缓存' : ''), x, 495, 15, '#9aa69d', '', width);
  }

  function draw() {
    var cfg = settings();
    var now = Date.now();
    var stamina = state.stamina ? core.deriveStamina(state.stamina, now) : null;
    var x = cfg.safeLeft + 24;
    var right = 876;
    var width = right - x;
    var accent = cfg.accent;
    var pale = '#f3f4e9';
    var hasData = stamina && Number.isFinite(stamina.current) && Number.isFinite(stamina.max);
    var stale = hasData && stamina.stale;
    var failed = !!state.error;
    ctx.save();
    if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.scale(W / 912, H / 596);
    ctx.fillStyle = '#101315';
    ctx.fillRect(0, 0, 912, 596);
    actions = [];
    // The camera side contains only decoration, never essential values or actions.
    // The two physical lenses end around x=260 on the default 912px layout.
    // Keep the text's safe inset, but bring this decorative boundary closer to them.
    var cameraBoundary = Math.max(0, cfg.safeLeft - 44);
    ctx.fillStyle = '#14191a';
    ctx.fillRect(0, 0, cameraBoundary, 596);
    for (var stripe = -596; stripe < cfg.safeLeft + 596; stripe += 64) {
      line(stripe, 0, stripe - 596, 596, '#1c2423', 1);
    }
    if (cameraBoundary > 0) line(cameraBoundary, 40, cameraBoundary, 556, '#303833', 1);
    // Let the chosen artwork fill the safe side; a left shade keeps values legible.
    ctx.globalAlpha = page === 0 ? 1 : 0.22;
    drawPortrait({ x: x + width * 0.12, y: 40, w: width * 0.88 + 36, h: 478 }, cfg);
    ctx.globalAlpha = 1;
    if (page === 0) {
      ctx.fillStyle = 'rgba(16,19,21,0.48)';
      ctx.fillRect(x - 4, 156, width * 0.37, 258);
    }

    ctx.fillStyle = accent;
    ctx.fillRect(x, 43, 7, 26);
    text('ENDFIELD', x + 18, 56, 23, pale, 'bold', width - 162);
    if (page === 0) drawPlayerTitle(x, width - 10, pale);
    else text(pageNames[page], x, 102, 32, pale, 'bold', width - 10);
    text('REAR TERMINAL  /  0' + (page + 1) + '  /  左右滑动切换', x, 132, 12, '#9aa69d', '', width);
    var status = busy ? '同步中' : (failed ? (String(state.error).indexOf('超时') >= 0 ? '同步超时' : '同步失败') : (stale ? '缓存数据' : (hasData ? '森空岛' : '未连接')));
    var statusWidth = 106;
    ctx.fillStyle = failed ? '#432b24' : '#242c24';
    ctx.fillRect(right - statusWidth, 43, statusWidth, 30);
    text(status, right - statusWidth + 12, 58, 16, failed ? '#ffb19a' : accent, '', statusWidth - 18);
    line(x, 154, right, 154, '#39403a');

    if (page === 0) drawOverview(cfg, stamina, x, right, width);
    else if (page === 1) drawGlory(cfg, x, right, width);
    else drawOperators(cfg, x, right, width);
    var syncedAt = page === 0 || state.detailsSyncedAt === undefined ? state.syncedAt : state.detailsSyncedAt;
    if (state.error || page !== 2) text(state.error || (syncedAt ? '同步于 ' + clockTime(syncedAt) : page ? '请在设置页同步资料' : '尚未同步'), x, 502, 14, state.error ? '#ffb19a' : '#9aa69d', '', width);
    var navWidth = (width - 166) / 3;
    var navNames = ['体力', '光荣', '养成'];
    for (var p = 0; p < 3; p++) {
      (function (index) {
        button(navNames[index], { x: x + index * (navWidth + 3), y: 530, w: navWidth, h: 42 }, function () { changePage(index); }, page === index, cfg);
      })(p);
    }
    refreshHit = { x: right - 150, y: 518, w: 150, h: 54 };
    ctx.fillStyle = '#263025';
    ctx.fillRect(refreshHit.x, refreshHit.y, refreshHit.w, refreshHit.h);
    text(busy ? '同步中' : '刷新理智', refreshHit.x + 18, refreshHit.y + 27, 19, accent, '', refreshHit.w - 30);
    ctx.restore();
  }

  function periodMs() { return Math.max(5, Number(settings().refreshMinutes) || 15) * 60000; }

  async function refresh(force) {
    if (stopped || busy || !service) return;
    var now = Date.now();
    if (!force && now - Math.max(lastAttemptAt, Number(state.syncedAt) || 0) < periodMs()) return;
    // Manual taps are also coalesced; failures wait for the configured next period.
    if (force && now - lastAttemptAt < 5000) return;
    lastAttemptAt = now;
    busy = true;
    var revision = ++refreshRevision;
    function complete(error) {
      if (stopped || revision !== refreshRevision) return;
      if (refreshTimerId !== null) { window.clearTimeout(refreshTimerId); refreshTimerId = null; }
      if (error) state.error = error.code === 'TIMEOUT' ? '同步超时，保留上次数据，点按重试' :
        (error.code === 'AUTH' ? '登录已失效，请在主屏设置中重新连接' : '同步未完成，保留上次数据，点按重试');
      busy = false;
      requestDraw();
    }
    // The service has its own deadline and invalidates expired writes. This UI
    // watchdog also bounds unexpected host/service failures without losing data.
    refreshTimerId = window.setTimeout(function () {
      complete({ code: 'TIMEOUT' });
      refreshRevision++;
    }, 65000);
    requestDraw();
    try {
      var next = await service.refresh();
      if (!stopped && revision === refreshRevision) acceptSnapshot(next, true);
    } catch (error) {
      // Only classified local messages reach the card; upstream text may contain credentials.
      complete(error || {});
    } finally {
      complete();
    }
  }

  async function reload() {
    if (!service || stopped) return;
    var revision = ++loadRevision;
    try {
      var snapshot = await service.getSnapshot();
      if (stopped || revision !== loadRevision) return;
      if (snapshot) acceptSnapshot(snapshot, true);
      var cfg = await service.getSettings();
      if (stopped || revision !== loadRevision) return;
      state.settings = cfg;
      requestDraw();
    } catch (error) {
      if (!stopped && revision === loadRevision) { state.error = '读取失败'; requestDraw(); }
    }
  }

  function point(e) {
    var rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
    return { x: (e.clientX - (rect.left || 0)) * 912 / (rect.width || W), y: (e.clientY - (rect.top || 0)) * 596 / (rect.height || H) };
  }
  function pointerDown(e) {
    if (stopped) return;
    if (pointer) { pointer.cancelled = true; return; }
    if (e.isPrimary === false) return;
    var p = point(e);
    if (p.x < settings().safeLeft) return;
    pointer = { id: e.pointerId, x: p.x, y: p.y, moved: false, axis: '', cancelled: false };
    if (typeof canvas.setPointerCapture === 'function') {
      try { canvas.setPointerCapture(e.pointerId); } catch (error) { /* Host may not support capture. */ }
    }
  }
  function pointerMove(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    var p = point(e);
    trackPointer(pointer, p);
  }
  function trackPointer(current, p) {
    var dx = Math.abs(p.x - current.x);
    var dy = Math.abs(p.y - current.y);
    if (dx > 12 || dy > 12) {
      current.moved = true;
      if (!current.axis) current.axis = dx > dy * 1.35 ? 'horizontal' : 'vertical';
    }
  }
  function inside(p, box) { return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h; }
  function pointerUp(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    var current = pointer;
    pointer = null;
    var p = point(e);
    trackPointer(current, p);
    if (typeof canvas.releasePointerCapture === 'function') {
      try { canvas.releasePointerCapture(e.pointerId); } catch (error) { /* Optional in the host. */ }
    }
    if (current.cancelled) return;
    var dx = p.x - current.x;
    var dy = p.y - current.y;
    if (current.axis === 'horizontal' && Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      changePage(page + (dx < 0 ? 1 : -1));
      return;
    }
    if (current.moved) return;
    if (inside(p, refreshHit)) { refresh(true); return; }
    for (var a = 0; a < actions.length; a++) {
      if (inside(p, actions[a].box)) { actions[a].run(); return; }
    }
  }
  function pointerCancel() { pointer = null; }
  function pointerLeave(e) {
    if (!pointer) return;
    if (typeof canvas.hasPointerCapture !== 'function' || !canvas.hasPointerCapture(e.pointerId)) pointer = null;
  }
  var listeners = [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp], ['pointercancel', pointerCancel], ['lostpointercapture', pointerCancel], ['pointerleave', pointerLeave]];
  for (var i = 0; i < listeners.length; i++) canvas.addEventListener(listeners[i][0], listeners[i][1]);

  window.__endfieldCardStop = function () {
    stopped = true;
    refreshRevision++;
    if (timerId !== null) window.clearInterval(timerId);
    if (refreshTimerId !== null) window.clearTimeout(refreshTimerId);
    if (frameId !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frameId);
    if (portraitImage) { portraitImage.onload = null; portraitImage.onerror = null; }
    Object.keys(medalImages).forEach(function (source) {
      medalImages[source].active = false;
      medalImages[source].image.onload = null;
      medalImages[source].image.onerror = null;
    });
    medalImages = Object.create(null);
    if (typeof canvas.removeEventListener === 'function') {
      for (var k = 0; k < listeners.length; k++) canvas.removeEventListener(listeners[k][0], listeners[k][1]);
    }
  };

  // All first-frame state and Data URLs are prepared before any asynchronous work.
  if (nativeBridge && nativeBridge.card && typeof nativeBridge.card.readSnapshot === 'function') {
    try { acceptSnapshot(nativeBridge.card.readSnapshot()); } catch (error) { /* Old snapshot falls back to the empty view. */ }
  }
  requestDraw();
  if (nativeBridge) {
    nativeBridge.config.onChange(function () { if (!stopped) reload(); });
    nativeBridge.card.onRefresh(function () { if (!stopped) reload(); });
  }
  async function start() {
    await reload();
    if (!stopped) refresh(false);
  }
  start();
  timerId = window.setInterval(function () {
    if (stopped) return;
    requestDraw();
    refresh(false);
  }, 60000);
})();

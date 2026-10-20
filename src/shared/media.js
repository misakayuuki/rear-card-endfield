(function (root) {
  'use strict';
  var ICON_BUDGET = 240000;
  function validImage(value) { return typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value); }
  function withDeadline(promise, milliseconds) {
    return new Promise(function (resolve, reject) {
      var timer = root.setTimeout(function () { reject(new Error('图片同步超时')); }, milliseconds);
      promise.then(function (value) { root.clearTimeout(timer); resolve(value); }, function (error) { root.clearTimeout(timer); reject(error); });
    });
  }
  async function hydrate(dashboard, previous, bridge) {
    if (!dashboard || !dashboard.glory || !Array.isArray(dashboard.glory.medals)) return dashboard;
    var output = JSON.parse(JSON.stringify(dashboard));
    var medals = output.glory.medals;
    var old = previous && previous.glory && Array.isArray(previous.glory.medals) ? previous.glory.medals : [];
    var perIcon = Math.min(24000, Math.floor(ICON_BUDGET / Math.max(1, medals.length)));
    var pending = [];
    medals.forEach(function (medal) {
      delete medal.iconDataUrl;
      var cached = old.find(function (item) { return item.id === medal.id && item.iconUrl === medal.iconUrl; });
      if (cached && validImage(cached.iconDataUrl) && cached.iconDataUrl.length <= perIcon) medal.iconDataUrl = cached.iconDataUrl;
      else if (typeof medal.iconUrl === 'string' && /^https:\/\//i.test(medal.iconUrl)) pending.push(medal);
    });
    // Only the settings/background WebViews can resize images. QuickJS reuses cached
    // icons instead of receiving an unbounded image response over its HostVar channel.
    if (!root.EndfieldImages || typeof root.EndfieldImages.prepare !== 'function') return output;
    var deadline = Date.now() + 12000;
    var index = 0;
    async function worker() {
      while (index < pending.length && Date.now() + 500 < deadline) {
        var medal = pending[index++];
        try {
          var response = await withDeadline(bridge.net.request({url: medal.iconUrl, responseType: 'base64',
            timeoutMs: 4000, redirect: 'manual', cookies: false, headers: {Accept: 'image/*'}}), Math.min(5000, deadline - Date.now()));
          if (!response || response.status !== 200 || typeof response.bodyBase64 !== 'string' || response.bodyBase64.length > 2800000) continue;
          var headers = response.headers || {};
          var header = headers['content-type'];
          var mime = String(Array.isArray(header) ? header[0] : header || '').split(';')[0].toLowerCase();
          if (!/^image\/(png|jpeg|webp)$/.test(mime)) continue;
          var binary = root.atob(response.bodyBase64), bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          var image = await withDeadline(root.EndfieldImages.prepare(new root.Blob([bytes], {type: mime}),
            {maxDimension: 256, maxChars: perIcon}), Math.max(1, deadline - Date.now()));
          if (image && validImage(image.dataUrl) && image.dataUrl.length <= perIcon) medal.iconDataUrl = image.dataUrl;
        } catch (_) { /* A missing icon must never discard stamina or the selected medal. */ }
      }
    }
    await Promise.all([worker(), worker()]);
    return output;
  }
  root.EndfieldMedia = {hydrate: hydrate};
})(typeof window !== 'undefined' ? window : globalThis);

(function () {
  'use strict';
  var state = { schemaVersion: 1, settings: {}, stamina: null, profile: null, dashboard: null, portrait: null, syncedAt: 0, error: null };
  var refreshCallbacks = [];
  var configCallbacks = [];
  var localOrigin = window.location.origin;
  // This isolated preview supplies only in-memory reads; it has no native network or storage bridge.
  window.bridge = {
    config: { onChange: function (callback) { configCallbacks.push(callback); } },
    card: {
      readSnapshot: function () { return state; },
      onRefresh: function (callback) { refreshCallbacks.push(callback); }
    }
  };
  window.EndfieldService = {
    create: function () {
      return {
        getSettings: async function () { return state.settings; },
        getSnapshot: async function () { return state; },
        refresh: async function () { return state; }
      };
    }
  };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== localOrigin) return;
    var message = event.data;
    if (!message || message.type !== 'endfield:preview' || !window.EndfieldCore.validSnapshot(message.snapshot)) return;
    var image = message.snapshot.portrait && message.snapshot.portrait.dataUrl;
    if (image && (typeof image !== 'string' || image.length > 160000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))) return;
    state = message.snapshot;
    refreshCallbacks.forEach(function (callback) { callback(); });
  });
  window.parent.postMessage({ type: 'endfield:preview:ready' }, localOrigin === 'null' ? '*' : localOrigin);
})();

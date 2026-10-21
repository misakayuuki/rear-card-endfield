(function (root) {
  'use strict';
  function bounded(value, fallback, min, max) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  }
  function result(dataUrl, canvas) {
    var comma = dataUrl.indexOf(',');
    var base64 = dataUrl.slice(comma + 1);
    var padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return { dataUrl: dataUrl, width: canvas.width, height: canvas.height,
      bytes: Math.max(0, Math.floor(base64.length * 3 / 4) - padding),
      mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) };
  }
  function fromDataUrl(dataUrl) {
    var match = typeof dataUrl === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,/.exec(dataUrl.slice(0, 24));
    if (!match) throw new Error('立绘图片格式不支持，请使用本地上传。');
    if (dataUrl.length - match[0].length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error('图片超过 20 MB，请先缩小后选择。');
    var binary;
    try { binary = atob(dataUrl.slice(match[0].length)); }
    catch (_) { throw new Error('立绘图片无法读取，请重新选择图片。'); }
    if (!binary.length) throw new Error('立绘图片无法读取，请重新选择图片。');
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1] });
  }
  async function prepare(file, options) {
    options = options || {};
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请先缩小后选择。');
    var maxDimension = bounded(options.maxDimension, 1600, 32, 1600);
    var maxChars = bounded(options.maxChars, 480000, 1000, 480000);
    var url = URL.createObjectURL(file);
    var image = new Image();
    try {
      await new Promise(function (resolve, reject) {
        image.onload = resolve;
        image.onerror = function () { reject(new Error('图片无法读取，请换一张图片。')); };
        image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 80000000) throw new Error('图片尺寸过大，请先缩小后选择。');
      var canvas = document.createElement('canvas');
      // Keep source pixels up to 1600px; a small original is never enlarged here.
      var ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      var qualities = [0.94, 0.86, 0.78];
      var webpSupported = true;
      for (var attempt = 0; attempt < 18; attempt += 1) {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('当前环境无法处理图片。');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        // WebP retains transparency while avoiding the heavy shrinking required by PNG.
        // Lower encoding quality modestly before discarding any more source pixels.
        if (webpSupported) {
          for (var quality = 0; quality < qualities.length; quality += 1) {
            var webp = canvas.toDataURL('image/webp', qualities[quality]);
            if (webp.indexOf('data:image/webp;base64,') !== 0) {
              webpSupported = false;
              break;
            }
            if (webp.length <= maxChars) return result(webp, canvas);
          }
        }
        if (!webpSupported) {
          // Unsupported WebP encoders return PNG. Keep alpha for PNG/WebP inputs.
          var fallbackType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          for (var fallbackQuality = 0; fallbackQuality < (fallbackType === 'image/png' ? 1 : qualities.length); fallbackQuality += 1) {
            var fallback = canvas.toDataURL(fallbackType, qualities[fallbackQuality]);
            if (/^data:image\/(png|jpeg);base64,/.test(fallback) && fallback.length <= maxChars) return result(fallback, canvas);
          }
        }
        ratio *= 0.9;
      }
      throw new Error('图片无法压缩到适合背屏的大小，请换一张图片。');
    } finally {
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    }
  }
  root.EndfieldImages = { prepare: prepare, fromDataUrl: fromDataUrl };
})(typeof window !== 'undefined' ? window : globalThis);

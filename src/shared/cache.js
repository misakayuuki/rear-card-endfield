(function (root) {
  'use strict';
  // Native snapshots cross both UTF-16 Binder and UTF-8 host-variable boundaries.
  // Keep the exact image bytes while fitting both transports, without compression.
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var BASE = 0x4000;
  var SMALL_CHARS = 180000;
  var NATIVE_CHARS = 450000;
  var NATIVE_UTF8_BYTES = 802000;
  var SNAPSHOT_CHARS = 760000;
  var PORTRAIT_CHARS = 480000;
  var ICON_CHARS = 24000;
  var ICON_TOTAL_CHARS = 240000;
  var indices = Object.create(null);
  for (var i = 0; i < ALPHABET.length; i++) indices[ALPHABET.charAt(i)] = i;

  function error(code) {
    var value = new Error(code === 'SNAPSHOT_SIZE' ? '背屏快照超过容量，请缩小图片后再保存。' : '背屏快照格式异常，请重新同步。');
    value.code = code;
    return value;
  }
  function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function copyRecord(value) {
    var copy = {};
    Object.keys(value).forEach(function (key) {
      Object.defineProperty(copy, key, { value: value[key], enumerable: true, writable: true, configurable: true });
    });
    return copy;
  }
  function copyImageContainers(source) {
    // Image transforms only assign these fields. Share all other metadata to
    // avoid retaining a serialized snapshot plus a second copy of every image.
    var value = copyRecord(source);
    if (record(value.portrait)) value.portrait = copyRecord(value.portrait);
    if (record(value.dashboard)) {
      value.dashboard = copyRecord(value.dashboard);
      if (record(value.dashboard.glory)) {
        value.dashboard.glory = copyRecord(value.dashboard.glory);
        if (Array.isArray(value.dashboard.glory.medals)) {
          value.dashboard.glory.medals = value.dashboard.glory.medals.map(function (medal) {
            return record(medal) ? copyRecord(medal) : medal;
          });
        }
      }
    }
    return value;
  }
  function serialize(value, limit) {
    var text;
    try { text = JSON.stringify(value); } catch (_) { throw error('SNAPSHOT_FORMAT'); }
    if (typeof text !== 'string') throw error('SNAPSHOT_FORMAT');
    if (text.length > limit) throw error('SNAPSHOT_SIZE');
    return text;
  }
  function validateNativeBytes(text) {
    // Android JSONStringer escapes slash; count those extra bytes as well.
    // Reserve the remaining live payload budget for the script and envelope.
    var bytes = 0;
    for (var index = 0; index < text.length; index++) {
      var code = text.charCodeAt(index);
      if (code < 128) bytes += code === 47 ? 2 : 1;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
          text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4; index++;
      } else bytes += 3;
      if (bytes > NATIVE_UTF8_BYTES) throw error('SNAPSHOT_SIZE');
    }
  }
  function blank(value) { return value === undefined || value === null || value === ''; }
  function imageParts(value, limit) {
    if (typeof value !== 'string') throw error('SNAPSHOT_FORMAT');
    if (value.length > limit) throw error('SNAPSHOT_SIZE');
    // QuickJS can exhaust its regexp workspace on a 480K image. Validate the
    // short prefix separately, then scan symbols using constant auxiliary space.
    var match = /^data:image\/(?:png|jpeg|webp);base64,/.exec(value.slice(0, 24));
    if (!match || value.length === match[0].length) throw error('SNAPSHOT_FORMAT');
    for (var index = match[0].length; index < value.length; index++) {
      var code = value.charCodeAt(index);
      if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 ||
          code === 43 || code === 47 || code === 61)) throw error('SNAPSHOT_FORMAT');
    }
    return { prefix: match[0], body: value.slice(match[0].length) };
  }
  function visitImages(value, transform) {
    if (record(value.portrait) && own(value.portrait, 'dataUrl')) {
      value.portrait.dataUrl = transform(value.portrait.dataUrl, PORTRAIT_CHARS, false);
    }
    var glory = value.dashboard && value.dashboard.glory;
    var medals = glory && glory.medals;
    if (Array.isArray(medals)) {
      medals.forEach(function (medal) {
        if (record(medal) && own(medal, 'iconDataUrl')) {
          medal.iconDataUrl = transform(medal.iconDataUrl, ICON_CHARS, true);
        }
      });
    }
  }
  function validateImages(value) {
    var total = 0;
    visitImages(value, function (image, limit, icon) {
      if (blank(image)) return image;
      imageParts(image, limit);
      if (icon) {
        total += image.length;
        if (total > ICON_TOTAL_CHARS) throw error('SNAPSHOT_SIZE');
      }
      return image;
    });
  }
  function encodeLegacyImage(data) {
    var body = data.body;
    var chunks = [], chunk = '';
    for (var offset = 0; offset < body.length; offset += 2) {
      var first = indices[body.charAt(offset)];
      var second = offset + 1 < body.length ? indices[body.charAt(offset + 1)] : 0;
      chunk += String.fromCharCode(BASE + first * 65 + second);
      if (chunk.length >= 4096) { chunks.push(chunk); chunk = ''; }
    }
    if (chunk) chunks.push(chunk);
    return { endfieldPackedImage: 1, prefix: data.prefix, length: body.length, pairs: chunks.join('') };
  }
  function symbolCode(index) {
    var code = index + 32;
    // Android JSONObject also escapes slash. No symbol needs JSON escaping.
    if (code >= 34) code++;
    if (code >= 47) code++;
    if (code >= 92) code++;
    if (code >= 127) code++;
    return code;
  }
  function symbolIndex(code) {
    if (code < 32 || code > 2083 || code === 34 || code === 47 || code === 92 || code === 127) {
      throw error('SNAPSHOT_FORMAT');
    }
    var index = code - 32;
    if (code > 34) index--;
    if (code > 47) index--;
    if (code > 92) index--;
    if (code > 127) index--;
    return index;
  }
  function bestShift(frequencies) {
    // The alphabet has 92 one-byte, 1920 two-byte and 36 three-byte UTF-8
    // symbols. Rotate their assignment using sliding sums, not a quadratic
    // search. Even highly repetitive images stay within the uniform byte bound.
    var low = 0, high = 0;
    for (var i = 0; i < 92; i++) low += frequencies[i];
    for (var j = 2012; j < 2048; j++) high += frequencies[j];
    var best = high - low, shift = 0;
    for (var step = 1; step < 2048; step++) {
      low += frequencies[(2048 - step) & 2047] - frequencies[(92 - step) & 2047];
      high += frequencies[(2012 - step) & 2047] - frequencies[(2048 - step) & 2047];
      if (high - low < best) { best = high - low; shift = step; }
    }
    return shift;
  }
  function encodeImage(value, limit) {
    if (blank(value)) return value;
    var data = imageParts(value, limit), body = data.body, end = body.length;
    while (end > 0 && body.charAt(end - 1) === '=') end--;
    var padding = body.length - end;
    // Older snapshots accepted unusual '=' placement. Preserve those strings
    // exactly using their original codec instead of silently normalizing them.
    if (padding > 2 || end === 0) return encodeLegacyImage(data);
    var frequencies = new Uint32Array(2048), bits = 0, available = 0;
    for (var offset = 0; offset < end; offset++) {
      var next = indices[body.charAt(offset)];
      if (next === 64) return encodeLegacyImage(data);
      bits = bits << 6 | next;
      available += 6;
      if (available >= 11) {
        available -= 11;
        frequencies[bits >>> available & 2047]++;
        bits &= (1 << available) - 1;
      }
    }
    if (available) frequencies[bits << (11 - available)]++;
    var shift = bestShift(frequencies), chunks = [], chunk = '';
    bits = 0; available = 0;
    for (var position = 0; position < end; position++) {
      bits = bits << 6 | indices[body.charAt(position)];
      available += 6;
      if (available >= 11) {
        available -= 11;
        chunk += String.fromCharCode(symbolCode(((bits >>> available & 2047) + shift) & 2047));
        bits &= (1 << available) - 1;
        if (chunk.length >= 4096) { chunks.push(chunk); chunk = ''; }
      }
    }
    if (available) chunk += String.fromCharCode(symbolCode(((bits << (11 - available)) + shift) & 2047));
    if (chunk) chunks.push(chunk);
    return { endfieldPackedImage: 2, prefix: data.prefix, length: body.length,
      padding: padding, shift: shift, symbols: chunks.join('') };
  }
  function decodeLegacyImage(value) {
    if (Object.keys(value).length !== 4 || !own(value, 'pairs') ||
        typeof value.pairs !== 'string' || value.pairs.length !== Math.ceil(value.length / 2)) throw error('SNAPSHOT_FORMAT');
    var chunks = [], chunk = '';
    for (var offset = 0; offset < value.pairs.length; offset++) {
      var code = value.pairs.charCodeAt(offset) - BASE;
      if (code < 0 || code >= 65 * 65) throw error('SNAPSHOT_FORMAT');
      var first = Math.floor(code / 65), second = code % 65;
      chunk += ALPHABET.charAt(first);
      if (offset * 2 + 1 < value.length) chunk += ALPHABET.charAt(second);
      else if (second !== 0) throw error('SNAPSHOT_FORMAT');
      if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
    }
    if (chunk) chunks.push(chunk);
    return value.prefix + chunks.join('');
  }
  function decodeImage(value, limit) {
    if (blank(value)) return value;
    if (!record(value) || !own(value, 'prefix') || !own(value, 'length') ||
        typeof value.prefix !== 'string' || value.prefix.length > 24 || !/^data:image\/(?:png|jpeg|webp);base64,$/.test(value.prefix) ||
        !Number.isInteger(value.length) || value.length <= 0) throw error('SNAPSHOT_FORMAT');
    if (value.prefix.length + value.length > limit) throw error('SNAPSHOT_SIZE');
    if (value.endfieldPackedImage === 1) return decodeLegacyImage(value);
    if (value.endfieldPackedImage !== 2 || Object.keys(value).length !== 6 ||
        !own(value, 'padding') || !own(value, 'shift') || !own(value, 'symbols') ||
        !Number.isInteger(value.padding) || value.padding < 0 || value.padding > 2 || value.padding >= value.length ||
        !Number.isInteger(value.shift) || value.shift < 0 || value.shift >= 2048 ||
        typeof value.symbols !== 'string' || value.symbols.length !== Math.ceil((value.length - value.padding) * 6 / 11)) {
      throw error('SNAPSHOT_FORMAT');
    }
    var chunks = [], chunk = '', bits = 0, available = 0, written = 0;
    var count = value.length - value.padding;
    for (var offset = 0; offset < value.symbols.length; offset++) {
      bits = bits << 11 | (symbolIndex(value.symbols.charCodeAt(offset)) - value.shift & 2047);
      available += 11;
      while (available >= 6 && written < count) {
        available -= 6;
        chunk += ALPHABET.charAt(bits >>> available & 63);
        written++;
      }
      bits &= (1 << available) - 1;
      if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
    }
    // Padding bits must be zero; length and '=' suffix restore the exact input.
    if (written !== count || bits !== 0) throw error('SNAPSHOT_FORMAT');
    if (chunk) chunks.push(chunk);
    return value.prefix + chunks.join('') + (value.padding === 2 ? '==' : value.padding === 1 ? '=' : '');
  }
  function pack(snapshot) {
    if (!record(snapshot) || own(snapshot, 'endfieldPackedSnapshot')) throw error('SNAPSHOT_FORMAT');
    var length = serialize(snapshot, SNAPSHOT_CHARS).length;
    // Validate without assigning anything to the original object, including frozen snapshots.
    var value = copyImageContainers(snapshot);
    validateImages(value);
    if (length <= SMALL_CHARS) return snapshot;
    visitImages(value, encodeImage);
    var result = { endfieldPackedSnapshot: 1, value: value };
    validateNativeBytes(serialize(result, NATIVE_CHARS));
    return result;
  }
  function unpack(nativeSnapshot) {
    try {
      if (!record(nativeSnapshot)) return null;
      var packed = own(nativeSnapshot, 'endfieldPackedSnapshot');
      serialize(nativeSnapshot, packed ? NATIVE_CHARS : SNAPSHOT_CHARS);
      if (!packed) {
        // Preserve legacy data even when an old image is invalid. The renderer can
        // skip that image without losing otherwise usable stamina/profile values.
        return nativeSnapshot;
      }
      if (Object.keys(nativeSnapshot).length !== 2 || nativeSnapshot.endfieldPackedSnapshot !== 1 ||
          !own(nativeSnapshot, 'value') || !record(nativeSnapshot.value) || own(nativeSnapshot.value, 'endfieldPackedSnapshot')) return null;
      var value = copyImageContainers(nativeSnapshot.value);
      visitImages(value, decodeImage);
      validateImages(value);
      serialize(value, SNAPSHOT_CHARS);
      return value;
    } catch (_) { return null; }
  }
  root.EndfieldCache = { pack: pack, unpack: unpack };
})(typeof window !== 'undefined' ? window : globalThis);

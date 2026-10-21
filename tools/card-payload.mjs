import { transformAsync } from '../upstream/rear-card-bridge/tools/card-build/node_modules/@babel/core/lib/index.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let decoderBuild;
/** Standard ESM tree shaking retains only the two synchronous streaming decoders. */
export function buildCardFflate() {
  if (!decoderBuild) decoderBuild = build({
    stdin: {
      contents: 'import { Gunzip, DecodeUTF8 } from "./upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/browser.js";\n' +
        '(typeof window !== "undefined" ? window : globalThis).fflate = { Gunzip, DecodeUTF8 };',
      resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'card-fflate-entry.js', loader: 'js'
    },
    bundle: true, treeShaking: true, minify: false, format: 'iife', platform: 'browser',
    target: 'es2017', write: false, legalComments: 'none', charset: 'utf8', logLevel: 'silent'
  }).then(result => result.outputFiles[0].text);
  return decoderBuild;
}

/** Formatting only: the official async-to-generator pass must run first. */
export async function compactCardEntries(entries) {
  const result = { ...entries };
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith('card/') || !name.endsWith('.js')) continue;
    const output = await transformAsync(Buffer.from(bytes).toString('utf8'), {
      babelrc: false, configFile: false, sourceType: 'script',
      compact: true, comments: false, minified: false, sourceMaps: false, plugins: []
    });
    result[name] = new Uint8Array(Buffer.from(output.code, 'utf8'));
  }
  return result;
}

/** Same classic-script order and separator as CardPackageBuilder.combineScripts. */
export function combinedCardScript(entries) {
  const html = Buffer.from(entries['card/index.html']).toString('utf8');
  const parts = [], seen = [];
  for (const match of html.matchAll(/<script\s+src=["']([^"']+)["']\s*>\s*<\/script>/gi)) {
    const name = match[1];
    if (!entries['card/' + name]) throw new Error('Missing card script: ' + name);
    parts.push(Buffer.from(entries['card/' + name]).toString('utf8'));
    seen.push(name);
  }
  if (!seen.includes('main.js')) parts.push(Buffer.from(entries['card/main.js']).toString('utf8'));
  return parts.join('\n;\n');
}

// Android org.json.JSONStringer escapes forward slashes in quoted strings.
// JSON.stringify alone undercounts actual ContentProvider/CursorWindow bytes.
export function androidJson(value) { return JSON.stringify(value).replaceAll('/', '\\/'); }

export function payloadMetrics(script, snapshot) {
  const live = androidJson({ revision: 123456, script, snapshotRev: 123456, snapshot });
  const outbox = JSON.stringify({
    batch: 'b-diagnostic-budget-123456789', module: 'dev.endfield.rearcard', acks: [],
    requests: [{ id: 'r-diagnostic-budget-123456789', op: 'card.saveSnapshot', args: { value: snapshot } }]
  });
  return {
    scriptChars: script.length, scriptUtf8Bytes: Buffer.byteLength(script, 'utf8'),
    snapshotChars: JSON.stringify(snapshot).length,
    snapshotUtf8Bytes: Buffer.byteLength(androidJson(snapshot), 'utf8'),
    liveChars: live.length, liveUtf8Bytes: Buffer.byteLength(live, 'utf8'),
    liveUtf16WithOverhead: live.length * 2 + 16384,
    outboxUtf16WithOverhead: outbox.length * 2 + 16384
  };
}

/** Maximum artwork and 24 KiB dashboard metadata, plus the outer snapshot fields. */
export function maximumSnapshot(pattern = 'random', metadataVariant = 'unicode') {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let random = 0x49f32ab1;
  function body(length) {
    if (pattern === 'slash') return '/'.repeat(length);
    if (pattern === 'zero') return 'A'.repeat(length);
    if (pattern === 'mixed') return '+/'.repeat(Math.ceil(length / 2)).slice(0, length);
    const pieces = [];
    for (let offset = 0; offset < length; offset += 8192) {
      let piece = '';
      for (let index = offset; index < Math.min(length, offset + 8192); index++) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        piece += alphabet[random >>> 26];
      }
      pieces.push(piece);
    }
    return pieces.join('');
  }
  const value = {
    schemaVersion: 1, sessionRevision: 'synthetic-budget-session-123456789',
    settings: { characterName: '佩丽卡🌌', accent: '#E5F56A', safeLeft: 336, fit: 'cover',
      portraitPositionX: 50, portraitPositionY: 40, portraitScale: 1.2, refreshMinutes: 15 },
    profile: { name: '管理员🌌#1234', level: 60, server: '国服' },
    stamina: { current: 123, max: 360, updatedAt: 1800000000000, recoveryAt: 1800030000000, secondsPerPoint: null },
    portrait: { dataUrl: '' },
    dashboard: { glory: { displayKnown: true, displayCount: 10,
      medals: Array.from({ length: 10 }, (_, index) => ({ id: 'medal-' + index, name: '展示蚀刻章🌌' + index, iconDataUrl: '' })) }, operators: [], metadataPadding: '' },
    syncedAt: 1800000000000, error: null
  };
  const metadataBudget = 24 * 1024;
  const remaining = metadataBudget - Buffer.byteLength(JSON.stringify(value.dashboard), 'utf8');
  value.dashboard.metadataPadding = metadataVariant === 'ascii' ? 'x'.repeat(remaining) :
    '界🌌'.repeat(Math.floor(remaining / 7)) + 'x'.repeat(remaining % 7);
  const portraitPrefix = 'data:image/webp;base64,', iconPrefix = 'data:image/png;base64,';
  value.portrait.dataUrl = portraitPrefix + body(480000 - portraitPrefix.length);
  for (const medal of value.dashboard.glory.medals) medal.iconDataUrl = iconPrefix + body(24000 - iconPrefix.length);
  return value;
}

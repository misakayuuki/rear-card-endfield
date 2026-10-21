'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { gzipSync } = require('node:zlib');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const load = name => import(pathToFileURL(path.join(root, name)).href);
const fixtures = (async () => {
  const tools = await load('tools/card-payload.mjs');
  const { compileScript } = await load('upstream/rear-card-bridge/tools/card-build/src/compile.js');
  const entries = {
    'card/index.html': Buffer.from(read('src/card/index.html')),
    'module.json': Buffer.from(read('src/module.json')),
    'webroot/app.js': Buffer.from(read('src/webroot/app.js')),
    'card/fflate-LICENSE.txt': Buffer.from(read('upstream/rear-card-bridge/tools/card-build/node_modules/fflate/LICENSE')),
    'webroot/crypto-js-LICENSE.txt': Buffer.from(read('node_modules/crypto-js/LICENSE'))
  };
  const names = [...read('src/card/index.html').matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  for (const name of names) {
    let source;
    if (name === 'crypto.js') source = ['core.js', 'sha256.js', 'md5.js', 'hmac.js'].map(file => read('node_modules/crypto-js/' + file)).join('\n;\n');
    else if (name === 'fflate.js') source = await tools.buildCardFflate();
    else source = read((name === 'main.js' ? 'src/card/' : 'src/shared/') + name);
    entries['card/' + name] = Buffer.from(await compileScript(source, 'card/' + name));
  }
  const compact = await tools.compactCardEntries(entries);
  const scope = vm.createContext({});
  scope.window = scope;
  vm.runInContext(Buffer.from(compact['card/cache.js']).toString('utf8'), scope);
  return { ...tools, entries, compact, cache: scope.EndfieldCache };
})();

test('format-only compact output preserves each card AST and all other entry bytes', async () => {
  const { entries, compact, combinedCardScript } = await fixtures;
  const { parseAsync } = await load('upstream/rear-card-bridge/tools/card-build/node_modules/@babel/core/lib/index.js');
  const plain = ast => JSON.parse(JSON.stringify(ast, (key, value) =>
    ['start', 'end', 'loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key) ? undefined : value));
  for (const name of Object.keys(entries)) {
    if (!name.startsWith('card/') || !name.endsWith('.js')) {
      assert.deepEqual(compact[name], entries[name]);
      continue;
    }
    const options = { babelrc: false, configFile: false, sourceType: 'script' };
    const before = await parseAsync(Buffer.from(entries[name]).toString('utf8'), options);
    const after = await parseAsync(Buffer.from(compact[name]).toString('utf8'), options);
    assert.deepEqual(plain(after), plain(before), name + ' must change formatting only');
    new vm.Script(Buffer.from(compact[name]).toString('utf8'), { filename: name });
  }
  assert(combinedCardScript(compact).length < combinedCardScript(entries).length * 0.75,
    'the live provider must send substantially less script text');
});

test('maximum image snapshots and actual combined scripts fit Android live and Binder byte budgets', async t => {
  const { compact, cache, combinedCardScript, maximumSnapshot, payloadMetrics, androidJson } = await fixtures;
  assert.equal(androidJson({ path: 'https://example.com/a/b' }), '{"path":"https:\\/\\/example.com\\/a\\/b"}');
  const script = combinedCardScript(compact);
  const cases = ['random', 'slash', 'zero', 'mixed'].map(pattern => ({ pattern, metadata: 'unicode' }));
  cases.push({ pattern: 'random', metadata: 'ascii' });
  for (const { pattern, metadata: variant } of cases) {
    const label = pattern + '/' + variant;
    const original = maximumSnapshot(pattern, variant);
    assert.equal(original.portrait.dataUrl.length, 480000);
    assert.equal(original.dashboard.glory.medals.reduce((sum, medal) => sum + medal.iconDataUrl.length, 0), 240000);
    const metadata = structuredClone(original.dashboard);
    for (const medal of metadata.glory.medals) medal.iconDataUrl = '';
    assert.equal(Buffer.byteLength(JSON.stringify(metadata), 'utf8'), 24 * 1024);
    const packed = cache.pack(original);
    assert.equal(JSON.stringify(cache.unpack(packed)), JSON.stringify(original));
    const metrics = payloadMetrics(script, packed);
    assert(metrics.liveUtf8Bytes < 900000, label + ' Android live payload: ' + metrics.liveUtf8Bytes);
    assert(metrics.outboxUtf16WithOverhead < 1024 * 1024,
      label + ' Binder envelope: ' + metrics.outboxUtf16WithOverhead);
    assert(metrics.liveUtf16WithOverhead < 1024 * 1024,
      label + ' live UTF-16 Binder envelope: ' + metrics.liveUtf16WithOverhead);
    t.diagnostic(label + ': live=' + metrics.liveUtf8Bytes + ' UTF-8 bytes; live Binder=' + metrics.liveUtf16WithOverhead + '; snapshot Binder=' + metrics.outboxUtf16WithOverhead + ' bytes including overhead.');
  }
});

test('the bundled streaming decoders preserve compressed and UTF-8 chunk boundaries', async () => {
  const { compact } = await fixtures;
  const scope = vm.createContext({}); scope.window = scope;
  vm.runInContext(Buffer.from(compact['card/fflate.js']).toString('utf8'), scope);
  assert.deepEqual(Object.keys(scope.fflate).sort(), ['DecodeUTF8', 'Gunzip']);
  const samples = ['', 'ASCII / quote " and slash \\', '昵称🌌#1234 · 技能：恢复理智\n'.repeat(700)];
  for (const sample of samples) {
    const raw = Buffer.from(sample), compressed = gzipSync(raw), chunks = [];
    let complete = false;
    const gunzip = new scope.fflate.Gunzip((chunk, final) => { chunks.push(Buffer.from(chunk)); complete = final; });
    for (let at = 0; at < compressed.length;) {
      const end = Math.min(at + [1, 2, 7, 31, 512][at % 5], compressed.length);
      gunzip.push(compressed.subarray(at, end), end === compressed.length); at = end;
    }
    assert(complete);
    assert.deepEqual(Buffer.concat(chunks), raw);
    let decoded = '';
    const utf8 = new scope.fflate.DecodeUTF8(piece => { decoded += piece; });
    // One-byte pushes split every possible multibyte boundary, including emoji.
    for (let at = 0; at < raw.length; at++) utf8.push(raw.subarray(at, at + 1), false);
    utf8.push(new Uint8Array(0), true);
    assert.equal(decoded, sample);
  }
  assert.throws(() => new scope.fflate.Gunzip(() => {}).push(new Uint8Array(20), true));
  const unfinished = new scope.fflate.DecodeUTF8(() => {});
  unfinished.push(new Uint8Array([0xf0, 0x9f]), false);
  assert.throws(() => unfinished.push(new Uint8Array(0), true));
});

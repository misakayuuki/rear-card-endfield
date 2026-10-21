import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModuleZip } from '../upstream/rear-card-bridge/tools/card-build/src/build.js';
import { unzipSync, zipSync } from '../upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/index.mjs';
import { compactCardEntries, combinedCardScript, buildCardFflate } from './card-payload.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'src/module.json'), 'utf8'));
const stage = path.join(root, 'build/module');
// Remove only this verified generated directory, never an input or arbitrary path.
if (path.relative(root, stage) !== path.join('build', 'module')) throw new Error('Unexpected staging path');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(path.join(root, 'src/module.json'), path.join(stage, 'module.json'));
for (const dir of ['card', 'webroot']) await cp(path.join(root, 'src', dir), path.join(stage, dir), { recursive: true });
// Only the algorithms used by Skland request signing; no browser crypto dependency.
const crypto = (await Promise.all(['core.js', 'sha256.js', 'md5.js', 'hmac.js'].map(name =>
  readFile(path.join(root, 'node_modules/crypto-js', name), 'utf8')))).join('\n;\n');
const sharedNames = ['core.js', 'cache.js', 'api.js', 'media.js', 'service.js'];
const shared = await Promise.all(sharedNames.map(name => readFile(path.join(root, 'src/shared', name), 'utf8')));
for (const dir of ['card', 'webroot']) {
  await writeFile(path.join(stage, dir, 'crypto.js'), crypto);
  for (let i = 0; i < shared.length; i++) await writeFile(path.join(stage, dir, sharedNames[i]), shared[i]);
}
// Card detail responses stay gzip-compressed across the size-limited native bridge.
await writeFile(path.join(stage, 'card/fflate.js'), await buildCardFflate());
await cp(path.join(root, 'upstream/rear-card-bridge/tools/card-build/node_modules/fflate/LICENSE'), path.join(stage, 'card/fflate-LICENSE.txt'));
await mkdir(path.join(stage, 'webroot/preview'), { recursive: true });
await writeFile(path.join(stage, 'webroot/preview/core.js'), shared[0]);
await writeFile(path.join(stage, 'webroot/preview/cache.js'), shared[1]);
await cp(path.join(root, 'src/card/main.js'), path.join(stage, 'webroot/preview/renderer.js'));
await mkdir(path.join(stage, 'background'), { recursive: true });
const imageEncoder = await readFile(path.join(root, 'src/webroot/image.js'), 'utf8');
await writeFile(path.join(stage, 'background/main.js'), [crypto, imageEncoder, ...shared,
  'async function refresh() { await EndfieldService.create(bridge, { staminaOnly: true }).refresh(); }'].join('\n;\n'));
await cp(path.join(root, 'node_modules/crypto-js/LICENSE'), path.join(stage, 'webroot/crypto-js-LICENSE.txt'));
await mkdir(path.join(root, 'dist'), { recursive: true });
const readableDir = path.join(root, 'output', 'compiled-readable', manifest.version);
await mkdir(readableDir, { recursive: true });
// Keep the official readable compiler output for debugging outside the install ZIP.
const result = await buildModuleZip({ sourceDir: stage, outPath: path.join(readableDir, 'module.zip') });
const compiled = unzipSync(await readFile(result.outPath));
for (const name of result.compiled) {
  const target = path.join(readableDir, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, compiled[name]);
}
const compact = await compactCardEntries(compiled);
const outPath = path.join(root, 'dist', `endfield-rear-card-${manifest.version}.zip`);
await writeFile(outPath, zipSync(compact, { level: 9 }));
console.log(`Built ${outPath}: ${result.entryNames.length} files, ${result.compiled.length} compiled scripts. Card script ${combinedCardScript(compiled).length} → ${combinedCardScript(compact).length} characters.`);

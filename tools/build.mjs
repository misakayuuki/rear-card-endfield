import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModuleZip } from '../upstream/rear-card-bridge/tools/card-build/src/build.js';
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
const shared = await Promise.all(['core.js', 'api.js', 'service.js'].map(name => readFile(path.join(root, 'src/shared', name), 'utf8')));
for (const dir of ['card', 'webroot']) {
  await writeFile(path.join(stage, dir, 'crypto.js'), crypto);
  for (let i = 0; i < shared.length; i++) await writeFile(path.join(stage, dir, ['core.js', 'api.js', 'service.js'][i]), shared[i]);
}
await mkdir(path.join(stage, 'webroot/preview'), { recursive: true });
await writeFile(path.join(stage, 'webroot/preview/core.js'), shared[0]);
await cp(path.join(root, 'src/card/main.js'), path.join(stage, 'webroot/preview/renderer.js'));
await mkdir(path.join(stage, 'background'), { recursive: true });
await writeFile(path.join(stage, 'background/main.js'), [crypto, ...shared,
  'async function refresh() { await EndfieldService.create(bridge).refresh(); }'].join('\n;\n'));
await cp(path.join(root, 'node_modules/crypto-js/LICENSE'), path.join(stage, 'webroot/crypto-js-LICENSE.txt'));
await mkdir(path.join(root, 'dist'), { recursive: true });
const result = await buildModuleZip({ sourceDir: stage, outPath: path.join(root, 'dist', `endfield-rear-card-${manifest.version}.zip`) });
console.log(`Built ${result.outPath}: ${result.entryNames.length} files, ${result.compiled.length} compiled scripts.`);

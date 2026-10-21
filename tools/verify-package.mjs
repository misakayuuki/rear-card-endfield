import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHmac, createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from '../upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/index.mjs';
import { combinedCardScript, maximumSnapshot, payloadMetrics } from './card-payload.mjs';
const sourceManifest=JSON.parse(await readFile(new URL('../src/module.json',import.meta.url),'utf8'));
const files=unzipSync(await readFile(new URL(`../dist/endfield-rear-card-${sourceManifest.version}.zip`,import.meta.url)));
const text=name=>strFromU8(files[name]);
const manifest=JSON.parse(text('module.json'));
const readable=unzipSync(await readFile(new URL(`../output/compiled-readable/${sourceManifest.version}/module.zip`,import.meta.url)));
assert.deepEqual(Object.keys(files).sort(),Object.keys(readable).sort());
for(const name of Object.keys(files)) {
  if(!name.startsWith('card/')||!name.endsWith('.js')) assert.deepEqual(files[name],readable[name],name+' must retain original bytes');
}
assert.equal(manifest.apiVersion,2);
assert.deepEqual(manifest.capabilities,['network','storage']);
assert.match(text('card/index.html'),/<canvas/);
assert.match(text('webroot/index.html'),/<script src="bridge-shim.js"><\/script>/);
assert.ok(!files['webroot/bridge-shim.js'],'Host injects the real bridge shim');
for(const [name,value] of Object.entries(files)){
  assert.ok(/^(module.json|card\/|background\/|webroot\/)/.test(name));
  if(name.endsWith('.js')){
    const source=strFromU8(value); new vm.Script(source,{filename:name});
    if(name.startsWith('card/')) assert.ok(!/\basync\s+function\b/.test(source),name+' must be compiled');
  }
}
const scope={console};scope.window=scope;vm.createContext(scope);
for(const name of ['crypto','fflate','core','cache','api'])vm.runInContext(text('card/'+name+'.js'),scope);
assert.equal(typeof scope.fflate.Gunzip,'function');
assert.equal(typeof scope.fflate.DecodeUTF8,'function');
assert.deepEqual(Object.keys(scope.fflate).sort(),['DecodeUTF8','Gunzip']);
assert.equal(typeof scope.EndfieldCache.pack,'function');
const path='/test',query='roleId=1',timestamp=123;
const expected=createHash('md5').update(createHmac('sha256','test-key').update(path+query+timestamp+JSON.stringify({platform:'',timestamp:String(timestamp),dId:'',vName:''})).digest('hex')).digest('hex');
assert.equal(scope.EndfieldAPI.signedHeaders({cred:'test-cred',signToken:'test-key'},path,query,timestamp).sign,expected);
const background={console};background.window=background;vm.createContext(background);
vm.runInContext(text('background/main.js'),background);
assert.equal(typeof background.refresh,'function');
assert.equal(typeof background.EndfieldService.create,'function');
assert.equal(typeof background.EndfieldImages.prepare,'function');
assert.equal(typeof background.EndfieldMedia.hydrate,'function');
assert.equal(typeof background.EndfieldCache.pack,'function');
let backgroundOptions, backgroundRefreshed=false;
background.bridge={};
background.EndfieldService={create(bridge,options){backgroundOptions=options;return {async refresh(){backgroundRefreshed=true;}};}};
await background.refresh();
assert.equal(backgroundRefreshed,true);
assert.equal(backgroundOptions.staminaOnly,true,'automatic background refresh must preserve manually synced details');
assert.match(text('webroot/index.html'),/<script src="image.js"><\/script>/);
assert.match(text('card/index.html'),/<script src="media.js"><\/script>/);
assert.ok(files['card/fflate-LICENSE.txt']);
assert.ok(files['webroot/crypto-js-LICENSE.txt']);
const combined=combinedCardScript(files);
const budgets=[];
for(const [pattern,metadataVariant] of [['random','unicode'],['slash','unicode'],['zero','unicode'],['mixed','unicode'],['random','ascii']]) {
  const original=maximumSnapshot(pattern,metadataVariant);
  const packed=scope.EndfieldCache.pack(original);
  assert.equal(JSON.stringify(scope.EndfieldCache.unpack(packed)),JSON.stringify(original),'maximum art must round-trip');
  const metrics=payloadMetrics(combined,packed);
  assert(metrics.liveUtf8Bytes<900000,`${pattern}: Android live payload ${metrics.liveUtf8Bytes} bytes exceeds budget`);
  assert(metrics.liveUtf16WithOverhead<1024*1024,`${pattern}: live payload UTF-16 Binder budget exceeded`);
  assert(metrics.outboxUtf16WithOverhead<1024*1024,`${pattern}: native snapshot Binder budget exceeded`);
  budgets.push({pattern,metadataVariant,...metrics});
}
console.log('ZIP layout, original non-card files, compiled signing, background entry, and maximum live/Binder payload budgets verified.');
console.log(JSON.stringify(budgets));

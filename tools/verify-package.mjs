import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHmac, createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from '../upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/index.mjs';
const sourceManifest=JSON.parse(await readFile(new URL('../src/module.json',import.meta.url),'utf8'));
const files=unzipSync(await readFile(new URL(`../dist/endfield-rear-card-${sourceManifest.version}.zip`,import.meta.url)));
const text=name=>strFromU8(files[name]);
const manifest=JSON.parse(text('module.json'));
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
for(const name of ['crypto','core','api'])vm.runInContext(text('card/'+name+'.js'),scope);
const path='/test',query='roleId=1',timestamp=123;
const expected=createHash('md5').update(createHmac('sha256','test-key').update(path+query+timestamp+JSON.stringify({platform:'',timestamp:String(timestamp),dId:'',vName:''})).digest('hex')).digest('hex');
assert.equal(scope.EndfieldAPI.signedHeaders({cred:'test-cred',signToken:'test-key'},path,query,timestamp).sign,expected);
const background={console};background.window=background;vm.createContext(background);
vm.runInContext(text('background/main.js'),background);
assert.equal(typeof background.refresh,'function');
assert.equal(typeof background.EndfieldService.create,'function');
assert.equal(typeof background.EndfieldImages.prepare,'function');
assert.equal(typeof background.EndfieldMedia.hydrate,'function');
assert.match(text('webroot/index.html'),/<script src="image.js"><\/script>/);
assert.match(text('card/index.html'),/<script src="media.js"><\/script>/);
console.log('ZIP layout, all scripts, compiled card signing, and standalone background entry verified.');

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/webroot/image.js'),'utf8');
function runtime(width,height,encode,decodeError=false) {
  const calls=[],draws=[],released=[];
  const canvas={width:0,height:0,getContext:()=>({drawImage(){draws.push([canvas.width,canvas.height]);}}),
    toDataURL(type,quality){calls.push({type,quality,width:canvas.width,height:canvas.height});return encode(type,quality,canvas.width,canvas.height);}};
  const sandbox={Blob,atob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:value=>released.push(value)},
    Image:class {set src(value){this.naturalWidth=width;this.naturalHeight=height;if(decodeError)this.onerror();else this.onload();}},
    document:{createElement:()=>canvas}};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return {prepare:sandbox.EndfieldImages.prepare,fromDataUrl:sandbox.EndfieldImages.fromDataUrl,calls,draws,released};
}
const png={type:'image/png',size:1000000};
function encoded(type,length){return 'data:'+type+';base64,'+'A'.repeat(length);}

test('portrait keeps up to 1600px and adjusts quality before shrinking source pixels',async()=>{
  const r=runtime(2000,3000,(type,quality)=>encoded(type,quality>.9?500000:400000));
  const result=await r.prepare(png);
  assert.deepEqual(r.draws,[[1067,1600]],'quality adaptation must not immediately discard dimensions');
  assert.equal(result.mimeType,'image/webp');
  assert(result.dataUrl.length<=480000);
  assert.equal(result.width,1067);assert.equal(result.height,1600);
  assert(r.calls.length>1);
  assert.deepEqual(r.released,['blob:test']);
});

test('small original is not upsampled and medal preparation obeys its separate budget',async()=>{
  const small=runtime(90,120,type=>encoded(type,1000));
  const original=await small.prepare(png);
  assert.equal(original.width,90);assert.equal(original.height,120);
  const medal=runtime(400,600,(type,quality)=>encoded(type,quality>.8?25000:22000));
  const icon=await medal.prepare(png,{maxDimension:256,maxChars:24000});
  assert.equal(icon.height,256);assert.equal(icon.width,171);
  assert(icon.dataUrl.length<=24000);
  assert.deepEqual(medal.draws,[[171,256]]);
});

test('when WebP encoding is absent, transparent input never falls back to JPEG',async()=>{
  const r=runtime(1000,1000,(type,quality,w,h)=>encoded(type==='image/webp'?'image/png':type,Math.ceil(w*h*3)));
  const image=await r.prepare(png,{maxDimension:256,maxChars:24000});
  assert.equal(image.mimeType,'image/png');
  assert(image.dataUrl.length<=24000);
  assert(r.draws.length>1);
  assert(!r.calls.some(call=>call.type==='image/jpeg'),'alpha would be lost through JPEG');
});

test('failed decoding releases the object URL and unsupported files are rejected',async()=>{
  const r=runtime(0,0,()=>'',true);
  await assert.rejects(r.prepare(png),/图片无法读取/);
  assert.deepEqual(r.released,['blob:test']);
  await assert.rejects(r.prepare({type:'image/svg+xml',size:1000}),/请选择/);
  assert.equal(r.calls.length,0);
});

test('manual smaller portrait budget keeps 1280px maximum and transparent formats',async()=>{
  for (const type of ['image/png','image/webp']) {
    const r=runtime(2000,3000,(output,quality)=>encoded(output,quality>.9?330000:300000));
    const image=await r.prepare({type,size:1000000},{maxDimension:1280,maxChars:320000});
    assert.deepEqual(r.draws,[[853,1280]]);
    assert(image.dataUrl.length<=320000);
    assert.equal(image.mimeType,'image/webp');
    assert(!r.calls.some(call=>call.type==='image/jpeg'));
    const fallback=runtime(2000,3000,(output,quality,w,h)=>encoded(output==='image/webp'?'image/png':output,w*h));
    const compatible=await fallback.prepare({type,size:1000000},{maxDimension:1280,maxChars:320000});
    assert(compatible.width<=1280&&compatible.height<=1280);
    assert(compatible.dataUrl.length<=320000);
    assert.equal(compatible.mimeType,'image/png');
    assert(!fallback.calls.some(call=>call.type==='image/jpeg'),'transparent fallback must preserve alpha');
  }
});

test('local data URL conversion preserves bytes and rejects unsupported or broken sources',async()=>{
  const r=runtime(1,1,()=> '');
  const transparentPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const blob=r.fromDataUrl('data:image/png;base64,'+transparentPng);
  assert.equal(blob.type,'image/png');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from(transparentPng,'base64'));
  assert.throws(()=>r.fromDataUrl('https://example.test/image.png'),/格式不支持/);
  assert.throws(()=>r.fromDataUrl('data:image/svg+xml;base64,AAAA'),/格式不支持/);
  assert.throws(()=>r.fromDataUrl('data:image/png;base64,!!'),/无法读取/);
  assert.throws(()=>r.fromDataUrl('data:image/png;base64,'),/无法读取/);
});

async function settingsRuntime(portrait, prepare) {
  const elements=new Map(),conversions=[],saved=[],downloads=[];
  function element(id) {
    if(!elements.has(id))elements.set(id,{value:'',disabled:false,hidden:false,files:[],options:[],style:{},attributes:{},listeners:{},
      classList:{toggle(){}},contentWindow:{postMessage(){}},
      addEventListener(event,fn){this.listeners[event]=fn;},getAttribute(key){return this.attributes[key];},
      removeAttribute(key){delete this.attributes[key];},appendChild(child){this.options.push(child);}});
    return elements.get(id);
  }
  let snapshot={settings:{},portrait:portrait?{dataUrl:portrait}:null};
  const service={async getSettings(){return {};},async getSnapshot(){return snapshot;},async getCharacters(){return [];},
    async downloadPortrait(id){downloads.push(id);throw Error('unexpected download');},
    async saveSettings(value){snapshot.settings=value;},async setPortrait(value){saved.push(value);snapshot.portrait=value?{dataUrl:value}:null;}};
  const sandbox={document:{getElementById:element,querySelectorAll:selector=>selector==='[data-color]'?[]:[...elements.values()],
      createElement:()=>({}),documentElement:{style:{setProperty(){}}}},
    window:{bridge:{},location:{origin:'https://settings.test'},addEventListener(){},
      EndfieldService:{create:()=>service},EndfieldImages:{prepare,fromDataUrl(value){conversions.push(value);return {dataUrl:value};}}},
    setTimeout:()=>1,clearTimeout(){},setInterval(){}};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../src/webroot/app.js'),'utf8'),sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  async function click(id){await element(id).listeners.click();}
  return {element,click,conversions,saved,downloads,service};
}
function prepared(dataUrl){return {dataUrl,width:853,height:1280,bytes:200000};}

test('lower-occupancy action uses saved or pending image locally and waits for Save',async()=>{
  const requests=[];
  const r=await settingsRuntime('saved-original',async(file,options)=>{requests.push({file,options});return prepared(options?'smaller':'new-upload');});
  assert.equal(r.element('reduce-image').disabled,false);
  await r.click('reduce-image');
  assert.deepEqual(r.conversions,['saved-original']);
  assert.equal(requests[0].options.maxDimension,1280);
  assert.equal(requests[0].options.maxChars,320000);
  assert.deepEqual(r.saved,[],'reducing must not publish until explicitly saved');
  assert.deepEqual(r.downloads,[]);
  r.element('portrait-file').files=[png];
  await r.element('portrait-file').listeners.change();
  assert.equal(requests[1].options,undefined,'new uploads retain the default quality budget');
  await r.click('reduce-image');
  assert.deepEqual(r.conversions,['saved-original','new-upload']);
  await r.element('appearance-form').listeners.submit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(r.saved,['smaller']);
});

test('empty image and in-flight jobs cannot reduce or overwrite a newer removal',async()=>{
  const empty=await settingsRuntime(null,async()=>{throw Error('unexpected image job');});
  assert.equal(empty.element('reduce-image').disabled,true);
  await empty.click('reduce-image');
  assert.deepEqual(empty.conversions,[]);
  let finish;
  const r=await settingsRuntime('original',()=>new Promise(resolve=>{finish=resolve;}));
  const job=r.click('reduce-image');
  assert.equal(r.element('save-button').disabled,true);
  assert.equal(r.element('reduce-image').disabled,true);
  await r.click('reduce-image');
  assert.deepEqual(r.conversions,['original'],'one image job at a time');
  await r.click('remove-image');
  finish(prepared('obsolete-result'));
  await job;
  assert.equal(r.element('portrait-preview').hidden,true);
  assert.equal(r.element('reduce-image').disabled,true);
  assert.equal(r.element('save-button').disabled,false);
  assert.match(r.element('image-status').textContent,/移除/);
});

test('failed reduction preserves the current portrait and busy saves reject image work',async()=>{
  const r=await settingsRuntime('original',async()=>{throw Error('decode failed');});
  await r.click('reduce-image');
  assert.equal(r.element('portrait-preview').src,'original');
  assert.equal(r.element('reduce-image').disabled,false);
  assert.equal(r.element('save-button').disabled,false);
  assert.match(r.element('image-status').textContent,/当前立绘未改变/);
  assert.deepEqual(r.saved,[]);
  let finish;
  r.service.saveSettings=()=>new Promise(resolve=>{finish=resolve;});
  await r.element('appearance-form').listeners.submit({preventDefault(){}});
  assert.equal(r.element('reduce-image').disabled,true);
  await r.click('reduce-image');
  assert.deepEqual(r.conversions,['original'],'an active save prevents a new image conversion');
  finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.element('reduce-image').disabled,false);
});

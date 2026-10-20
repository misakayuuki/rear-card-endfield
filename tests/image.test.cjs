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
  const sandbox={URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:value=>released.push(value)},
    Image:class {set src(value){this.naturalWidth=width;this.naturalHeight=height;if(decodeError)this.onerror();else this.onload();}},
    document:{createElement:()=>canvas}};
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return {prepare:sandbox.EndfieldImages.prepare,calls,draws,released};
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

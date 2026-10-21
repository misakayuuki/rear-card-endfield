'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {gzipSync} = require('node:zlib');
const CryptoJS = require('crypto-js');
const root = path.join(__dirname, '..');
const auth = {accountToken:'test-token',cred:'test-cred',signToken:'test-key',userId:'test-user'};
const role = {id:'role:1',roleId:'test-role',serverId:'1',name:'管理员#1234'};
const minimal = {detail:{dungeon:{curStamina:'123',maxStamina:'360'},base:{name:'管理员#1234'},chars:[]}};
const ok = data => ({status:200,headers:{},body:JSON.stringify({code:0,data})});
function load(withDecoder = true, globals = {}, configureDecoder) {
  const context = vm.createContext({CryptoJS,Date,setTimeout,...globals});
  // Load the browser UMD without atob, Buffer, TextDecoder or browser DOM globals.
  if (withDecoder) vm.runInContext(fs.readFileSync(path.join(root,'upstream/rear-card-bridge/tools/card-build/node_modules/fflate/umd/index.js'),'utf8'),context);
  if (configureDecoder) configureDecoder(context.fflate);
  vm.runInContext(fs.readFileSync(path.join(root,'src/shared/api.js'),'utf8'),context);
  return context.EndfieldAPI;
}
function encoded(data, coding='gzip') {
  const raw=Buffer.from(JSON.stringify({code:0,data}));
  return {status:200,headers:{'content-encoding':[coding]},bodyBase64:(coding==='gzip'?gzipSync(raw):raw).toString('base64')};
}
function fixture() {
  const detail=structuredClone(minimal);
  detail.detail.chars=Array.from({length:420},(_,i)=>({
    charData:{id:'character-'+i,name:'测试干员'+i,illustrationUrl:'https://example.com/'+i+'.png',
      skills:[{id:'skill-'+i,name:'测试技能',description:'大型详情数据：角色技能、升级素材、图标与描述。'.repeat(220)}]},
    level:80,evolvePhase:4,potentialLevel:1,userSkills:{['skill-'+i]:{level:12}}
  }));
  return detail;
}

test('multi-megabyte detail crosses the card bridge as a small gzip envelope and normalizes normally', async()=>{
  const detail=fixture(), response=encoded(detail);
  const raw=JSON.stringify(ok(detail));
  assert(raw.length>2000000,'fixture reproduces a raw response beyond the native results cap');
  assert(JSON.stringify(response).length<200000,'compressed native result fits the rear bridge budget');
  const calls=[];
  const api=load().create({net:{request:async args=>{
    calls.push(args);
    if(calls.length===1)return ok({token:'new-key'});
    assert.equal(args.responseType,'base64');
    assert.equal(args.headers['Accept-Encoding'],'gzip');
    assert.equal(args.headers.cred,auth.cred);
    assert.equal(args.redirect,'manual');
    return response;
  }}},{compressed:true});
  const value=await api.fetchStamina(auth,role);
  assert.equal(calls.length,2);
  assert.equal(calls[0].responseType,'text','small authentication requests use their existing transport');
  assert.equal(calls[0].headers['Accept-Encoding'],undefined);
  assert.equal(value.stamina.current,123);
  assert.equal(value.profile.name,'管理员#1234');
  assert.equal(value.dashboard.operators[0].name,'测试干员0');
  assert.equal(value.dashboard.operatorsTruncated,true);
});

test('gzip negotiation accepts an uncompressed base64 response including Chinese text', async()=>{
  const calls=[];
  const api=load().create({net:{request:async args=>{
    calls.push(args);return calls.length===1?ok({token:'new-key'}):encoded(minimal,'identity');
  }}},{compressed:true});
  const value=await api.fetchStamina(auth,role);
  assert.equal(value.profile.name,'管理员#1234');
  assert.equal(value.stamina.current,123);
});

test('streaming UTF-8 preserves two, three and four byte characters split across chunks', async()=>{
  for(const name of ['é管理员#12','汉管理员#12','😀管理员#12']){
    const detail={padding:'',...structuredClone(minimal)};
    detail.detail.base.name=name;
    const prefixBytes=Buffer.from(JSON.stringify({code:0,data:detail})).indexOf(Buffer.from(name));
    detail.padding='x'.repeat(8191-prefixBytes);
    const response=encoded(detail,'identity');
    let calls=0;
    const api=load().create({net:{request:async()=>++calls===1?ok({token:'new-key'}):response}},{compressed:true});
    assert.equal((await api.fetchStamina(auth,role)).profile.name,name);
    assert.equal(calls,2);
  }
});

test('gzip work yields to host frames with bounded chunks before JSON parsing', async()=>{
  const detail=structuredClone(minimal);
  detail.unusedDescription='完整保留详情😀'.repeat(40000);
  const response=encoded(detail);
  const work={frame:0,gzip:[],utf8:[],parseFrame:0};
  let elapsed=0,calls=0;
  class BudgetClock extends Date { static now(){return elapsed+=8;} }
  const api=load(true,{
    Date:BudgetClock,
    requestAnimationFrame(callback){setImmediate(()=>{work.frame++;callback();});},
    setTimeout(){throw new Error('frame scheduling must take priority');},
    JSON:{stringify:JSON.stringify,parse(value){
      if(value.includes('unusedDescription'))work.parseFrame=work.frame;
      return JSON.parse(value);
    }}
  },helpers=>{
    const Gunzip=helpers.Gunzip, DecodeUTF8=helpers.DecodeUTF8;
    helpers.Gunzip=function(callback){
      const stream=new Gunzip(callback);
      this.push=(chunk,final)=>{work.gzip.push({size:chunk.length,frame:work.frame});stream.push(chunk,final);};
    };
    helpers.DecodeUTF8=function(callback){
      const stream=new DecodeUTF8(callback);
      this.push=(chunk,final)=>{work.utf8.push({size:chunk.length,frame:work.frame});stream.push(chunk,final);};
    };
    helpers.gunzipSync=helpers.strFromU8=()=>{throw new Error('synchronous whole-response helper used');};
  }).create({net:{request:async()=>++calls===1?ok({token:'new-key'}):response}},{compressed:true});
  const value=await api.fetchStamina(auth,role);
  assert.equal(value.stamina.current,123);
  assert(work.gzip.length>1);
  assert(work.gzip.every(chunk=>chunk.size<=512));
  assert(work.utf8.every(chunk=>chunk.size<=8192));
  assert(new Set(work.utf8.map(chunk=>chunk.frame)).size>3,'decoding allows other frames to run');
  assert(work.parseFrame>work.utf8.at(-1).frame,'JSON parsing receives a later frame budget');
  assert.equal(calls,2);
});

test('WebView clients preserve plain text requests and do not require a gzip decoder', async()=>{
  const calls=[];
  const api=load(false).create({net:{request:async args=>{
    calls.push(args);return calls.length===1?ok({token:'new-key'}):ok(minimal);
  }}});
  assert.equal((await api.fetchStamina(auth,role)).stamina.current,123);
  assert(calls.every(call=>call.responseType==='text'&&!call.headers['Accept-Encoding']));
});

test('malformed compressed data returns a safe data error without replaying the request', async()=>{
  const brokenTrailer=gzipSync(Buffer.from(JSON.stringify({code:0,data:minimal})));
  brokenTrailer.writeUInt32LE(9*1024*1024,brokenTrailer.length-4);
  const responses=[
    {status:200,headers:{'content-encoding':['gzip']},bodyBase64:'SECRET-invalid-base64'},
    {status:200,headers:{'content-encoding':['gzip']},bodyBase64:Buffer.from('SECRET-not-gzip').toString('base64')},
    {status:200,headers:{'content-encoding':['br']},bodyBase64:'AAAA'},
    {status:200,headers:{'content-encoding':['gzip']},bodyBase64:brokenTrailer.toString('base64')},
    {status:200,headers:{'content-encoding':['identity']},bodyBase64:'AA=A'},
    {status:200,headers:{'content-encoding':['identity']},bodyBase64:'AAAA===='},
    {status:200,headers:{'content-encoding':['identity']},bodyBase64:'AAAAＡAAA'},
    {status:200,headers:{'content-encoding':['identity']},bodyBase64:Buffer.from('SECRET-not-json').toString('base64')}
  ];
  for(const response of responses){
    let calls=0;
    const api=load().create({net:{request:async()=>++calls===1?ok({token:'new-key'}):response}},{compressed:true});
    await assert.rejects(api.fetchStamina(auth,role),e=>e.code==='DATA'&&!e.message.includes('SECRET'));
    assert.equal(calls,2);
  }
});

test('a forged gzip size cannot bypass the streaming output limit or trigger a retry', async()=>{
  const detail={...minimal,unused:'A'.repeat(9*1024*1024)};
  const compressed=gzipSync(Buffer.from(JSON.stringify({code:0,data:detail})));
  compressed.writeUInt32LE(1024,compressed.length-4);
  const response={status:200,headers:{'content-encoding':['gzip']},bodyBase64:compressed.toString('base64')};
  let calls=0,consumed=0,decoded=0;
  const api=load(true,{},helpers=>{
    const Gunzip=helpers.Gunzip, DecodeUTF8=helpers.DecodeUTF8;
    helpers.Gunzip=function(callback){
      const stream=new Gunzip(callback);
      this.push=(chunk,final)=>{consumed+=chunk.length;stream.push(chunk,final);};
    };
    helpers.DecodeUTF8=function(callback){
      const stream=new DecodeUTF8(callback);
      this.push=(chunk,final)=>{decoded+=chunk.length;stream.push(chunk,final);};
    };
  }).create({net:{request:async()=>++calls===1?ok({token:'new-key'}):response}},{compressed:true});
  await assert.rejects(api.fetchStamina(auth,role),error=>error.code==='DATA');
  assert.equal(calls,2);
  assert(consumed<compressed.length,'stop before expanding the complete oversized stream');
  assert(decoded<=8*1024*1024,'never pass oversized output to the text decoder');
});

test('compressed detail timeouts are not retried and cannot expose a response or credential', async()=>{
  let calls=0;
  const api=load().create({net:{request:async()=>{
    if(++calls===1)return ok({token:'new-key'});
    throw Object.assign(new Error('SECRET'),{code:'TIMEOUT'});
  }}},{compressed:true});
  await assert.rejects(api.fetchStamina(auth,role),e=>e.code==='TIMEOUT'&&!e.message.includes('SECRET'));
  assert.equal(calls,2);
});

test('missing card gzip helper fails explicitly before requesting a large detail response', async()=>{
  let calls=0;
  const api=load(false).create({net:{request:async()=>{calls++;return ok({token:'new-key'});}}},{compressed:true});
  await assert.rejects(api.fetchStamina(auth,role),e=>e.code==='RUNTIME');
  assert.equal(calls,1);
});

test('old synchronous-only gzip helpers cannot silently restore blocking card decoding', async()=>{
  for(const missing of ['Gunzip','DecodeUTF8']){
    let calls=0;
    const api=load(true,{},helpers=>{delete helpers[missing];})
      .create({net:{request:async()=>{calls++;return ok({token:'new-key'});}}},{compressed:true});
    await assert.rejects(api.fetchStamina(auth,role),error=>error.code==='RUNTIME');
    assert.equal(calls,1);
  }
});

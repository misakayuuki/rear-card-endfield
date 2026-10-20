const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/shared/media.js'),'utf8');
const icon='data:image/png;base64,AAAA';
function load(prepare){
  const scope={Date,Promise,Uint8Array,Blob,atob,setTimeout,clearTimeout};
  if(prepare)scope.EndfieldImages={prepare};
  scope.window=scope;vm.createContext(scope);vm.runInContext(source,scope);return scope.EndfieldMedia;
}
const data=()=>({glory:{displayKnown:true,displayCount:2,medals:[
  {id:'selected1',iconUrl:'https://example.com/one.png'},
  {id:'selected2',iconUrl:'https://example.com/two.png'}]},operators:[]});
test('QuickJS reuses matching icon data without downloading image responses',async()=>{
  const previous=data();previous.glory.medals[0].iconDataUrl=icon;
  let requests=0;
  const result=await load().hydrate(data(),previous,{net:{request(){requests++;}}});
  assert.equal(requests,0);assert.equal(result.glory.medals[0].iconDataUrl,icon);
  assert.equal(result.glory.medals[1].iconDataUrl,undefined);
});
test('WebView compresses only selected images without sending credentials or cookies',async()=>{
  const requests=[],options=[];
  const media=load(async(file,opts)=>{assert.equal(file.type,'image/png');options.push(opts);return {dataUrl:icon};});
  const result=await media.hydrate(data(),null,{net:{request:async request=>{
    requests.push(request);return {status:200,headers:{'content-type':['image/png']},bodyBase64:'AAAA'};
  }}});
  assert.equal(requests.length,2);assert.equal(options[0].maxDimension,256);assert.equal(options[0].maxChars,24000);
  for(const request of requests){assert.equal(request.cookies,false);assert.deepEqual(Object.keys(request.headers),['Accept']);}
  assert(result.glory.medals.every(m=>m.iconDataUrl===icon));
});
test('image failures retain selected medal identity and unrelated dashboard data',async()=>{
  const expected=data();expected.operatorCount=12;
  const media=load(async()=>({dataUrl:icon}));
  const result=await media.hydrate(expected,null,{net:{request:async()=>{throw new Error('private error');}}});
  assert.equal(result.operatorCount,12);assert.equal(result.glory.medals.length,2);
  assert.equal(result.glory.medals[0].id,'selected1');assert(!JSON.stringify(result).includes('private error'));
});
test('cached URLs must match the chosen variant and the aggregate icon budget is bounded',async()=>{
  const previous=data();previous.glory.medals[0].iconDataUrl=icon;
  const changed=data();changed.glory.medals[0].iconUrl='https://example.com/reforged.png';
  assert.equal((await load().hydrate(changed,previous,{})).glory.medals[0].iconDataUrl,undefined);
  const many={glory:{displayKnown:true,medals:Array.from({length:32},(_,i)=>({id:String(i),iconUrl:'https://example.com/'+i}))}};
  const cached=structuredClone(many);cached.glory.medals.forEach(m=>m.iconDataUrl='data:image/png;base64,'+'A'.repeat(9000));
  const result=await load().hydrate(many,cached,{});
  assert(result.glory.medals.reduce((sum,m)=>sum+(m.iconDataUrl||'').length,0)<=240000);
});

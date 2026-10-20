const {test} = require('node:test');
const assert = require('node:assert/strict');
require('../src/shared/core.js');
const authSecret = 'never-include-this-secret-in-snapshots';
const role = {id:'r1',uid:'u1',roleId:'1',serverId:'1',name:'测试管理员',server:'国服'};
let fetchImpl;
let connectImpl;
globalThis.EndfieldAPI = {create: () => ({connect: (...args) => connectImpl ? connectImpl(...args) : Promise.resolve({auth:{accountToken:authSecret},roles:[role]}),fetchStamina: (...args) => fetchImpl(...args)})};
require('../src/shared/service.js');
function setup() {
  const storage = new Map(), config = new Map(), snapshots = [];
  let requests = 0;
  const bridge = {
    storage: {
      get:async k=>{const value=storage.get(k)||null;assert(JSON.stringify(value).length<=200000,'one result fits the card HostVar');return value;},
      set:async(k,v)=>{assert(JSON.stringify(v).length<=256*1024,'one stored value fits the bridge limit');storage.set(k,v);},
      remove:async k=>storage.delete(k)
    },
    config: {get:async k=>config.get(k)||null,set:async(k,v)=>config.set(k,v)},
    card: {saveSnapshot:async s=>{assert(JSON.stringify(s).length<=760000);snapshots.push(s);},requestRefresh:async()=>{requests++;}}
  };
  return {storage,config,snapshots,bridge,service:globalThis.EndfieldService.create(bridge),get requests(){return requests;}};
}
test('connect -> role -> snapshot never publishes credentials, caches last data on failure', async () => {
  const s=setup();
  const dashboard={glory:{count:0,medals:[]},operatorCount:1,operators:[{id:'c1',name:'示例干员',level:60}]};
  const data={stamina:{current:0,max:240,updatedAt:Date.now()},profile:{name:role.name},dashboard};
  fetchImpl=async()=>data;
  await s.service.connect(authSecret);
  await s.service.selectRole(role);
  assert.equal(s.snapshots.at(-1).stamina.current,0);
  assert.deepEqual(s.snapshots.at(-1).dashboard,dashboard);
  await s.service.saveSettings({portraitScale:1.8});
  assert.deepEqual(s.snapshots.at(-1).dashboard,dashboard);
  assert.equal(s.snapshots.at(-1).settings.portraitScale,1.8);
  assert.ok(!JSON.stringify(s.snapshots).includes(authSecret));
  fetchImpl=async()=>{throw new Error('server echoed '+authSecret)};
  await assert.rejects(s.service.refresh());
  assert.equal(s.snapshots.at(-1).stamina.current,0);
  assert.ok(s.snapshots.at(-1).error);
  assert.deepEqual(s.snapshots.at(-1).dashboard,dashboard);
  assert.ok(!JSON.stringify(s.snapshots).includes(authSecret));
  await s.service.disconnect();
  assert.equal(s.storage.has('endfield.auth'),false);
  assert.equal(s.snapshots.at(-1).stamina,null);
  assert.equal(s.snapshots.at(-1).dashboard,null);
});
test('logout while refresh in flight cannot resurrect account or stamina', async () => {
  const s=setup(); let resolve;
  await s.service.connect(authSecret);
  s.config.set('role',role);
  fetchImpl=()=>new Promise(r=>{resolve=r});
  const inflight=s.service.refresh();
  await new Promise(r=>setImmediate(r));
  await s.service.disconnect();
  resolve({stamina:{current:120,max:240,updatedAt:Date.now()},profile:{name:'old'}});
  await inflight;
  assert.equal(s.snapshots.at(-1).stamina,null);
  assert.equal(s.storage.has('endfield.auth'),false);
});
test('portrait budget is bounded and retained through refresh', async () => {
  const s=setup();
  await assert.rejects(s.service.setPortrait('data:image/png;base64,'+'A'.repeat(480000)));
  await assert.rejects(s.service.setPortrait('https://example.com/image.png'));
  const image='data:image/png;base64,AAAA';
  await s.service.setPortrait(image);
  const v=await s.service.refresh();
  assert.equal(v.portrait.dataUrl,image);
  await s.service.setPortrait(null);
  assert.equal(s.snapshots.at(-1).portrait,null);
});

test('high-resolution portrait and medal images use bounded sequential storage chunks', async () => {
  const s=setup();const now=Date.now();
  const image='data:image/webp;base64,'+'A'.repeat(450000);
  const medal='data:image/png;base64,'+'B'.repeat(100000);
  await s.service.setPortrait(image);
  await s.service.connect(authSecret);
  fetchImpl=async()=>({stamina:{current:50,max:240,updatedAt:now},profile:{name:role.name},
    dashboard:{glory:{count:2,medals:[{id:'m1',dataUrl:medal},{id:'m2',dataUrl:medal}]},operators:[]}});
  await s.service.selectRole(role);
  const snapshot=await s.service.getSnapshot();
  assert.equal(snapshot.portrait.dataUrl,image);
  assert.equal(snapshot.dashboard.glory.medals[1].dataUrl,medal);
  assert(JSON.stringify(snapshot).length>600000,'the native snapshot may exceed the bridge result size');
  assert.equal(s.storage.get('endfield.snapshot').endfieldChunked,1);
  assert.equal(s.storage.get('endfield.portrait').endfieldChunked,1);
  const otherView=globalThis.EndfieldService.create(s.bridge);
  await otherView.saveSettings({portraitScale:2});
  assert.equal((await s.service.getSnapshot()).portrait.dataUrl,image);
  assert.equal(s.snapshots.at(-1).settings.portraitScale,2);
  await otherView.disconnect();
  assert.equal((await s.service.getSnapshot()).dashboard,null);
  assert.equal((await s.service.getSnapshot()).portrait.dataUrl,image);
  assert(!JSON.stringify(s.snapshots).includes(authSecret));
});

test('legacy direct cache values remain readable and migrate on the next save', async () => {
  const s=setup();const image='data:image/png;base64,'+'A'.repeat(159000);
  const legacy={schemaVersion:1,sessionRevision:'',settings:{},stamina:{current:55,max:240,updatedAt:Date.now()},
    profile:{name:'旧版昵称#1234'},portrait:{dataUrl:image},syncedAt:Date.now(),dashboard:null,error:null};
  s.storage.set('endfield.portrait',{dataUrl:image});
  s.storage.set('endfield.snapshot',legacy);
  assert.equal((await s.service.getSnapshot()).stamina.current,55);
  await s.service.saveSettings({portraitScale:1.5});
  assert.equal(s.storage.get('endfield.snapshot').endfieldChunked,1);
  const current=await s.service.getSnapshot();
  assert.equal(current.portrait.dataUrl,image);
  assert.equal(current.profile.name,'旧版昵称#1234');
});

test('an oversized combined snapshot preserves previously cached account data', async () => {
  const s=setup();const now=Date.now();
  await s.service.setPortrait('data:image/png;base64,'+'A'.repeat(450000));
  await s.service.connect(authSecret);
  fetchImpl=async()=>({stamina:{current:50,max:240,updatedAt:now},profile:{name:role.name},dashboard:{glory:{count:1,medals:[]}}});
  await s.service.selectRole(role);
  fetchImpl=async()=>({stamina:{current:80,max:240,updatedAt:now+1000},profile:{name:role.name},
    dashboard:{glory:{count:1,medals:[{id:'m',dataUrl:'data:image/png;base64,'+'B'.repeat(320000)}]}}});
  await assert.rejects(s.service.refresh(),/快照容量/);
  const current=await s.service.getSnapshot();
  assert.equal(current.stamina.current,50);
  assert.equal(current.dashboard.glory.medals.length,0);
  assert.ok(current.error);
});

test('failed replacement chunk never replaces or deletes the previous image', async () => {
  const s=setup();
  const original='data:image/png;base64,'+'A'.repeat(340000);
  await s.service.setPortrait(original);
  const pointer=s.storage.get('endfield.portrait');
  const storedSet=s.bridge.storage.set;
  s.bridge.storage.set=async(key,value)=>{
    if(key.startsWith('endfield.portrait.chunk.')&&key.endsWith('.1'))throw new Error('simulated storage failure');
    return storedSet(key,value);
  };
  await assert.rejects(s.service.setPortrait('data:image/png;base64,'+'B'.repeat(410000)),/simulated storage failure/);
  assert.deepEqual(s.storage.get('endfield.portrait'),pointer);
  assert.equal((await s.service.getSnapshot()).portrait.dataUrl,original);
  s.bridge.storage.set=storedSet;
  assert.equal((await s.service.refresh()).portrait.dataUrl,original);
});

test('a reader racing old-chunk cleanup follows the new committed snapshot', async () => {
  const s=setup();const image='data:image/png;base64,'+'A'.repeat(340000);
  await s.service.setPortrait(image);
  const storedGet=s.bridge.storage.get;let release,hold=true;
  s.bridge.storage.get=async key=>{
    if(key.startsWith('endfield.snapshot.chunk.')&&hold){hold=false;const captured=await storedGet(key);return new Promise(resolve=>{release=()=>resolve(captured);});}
    return storedGet(key);
  };
  const reading=s.service.getSnapshot();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  await globalThis.EndfieldService.create(s.bridge).saveSettings({portraitScale:2.25});
  release();
  const value=await reading;
  assert.equal(value.portrait.dataUrl,image);
  assert.equal(value.settings.portraitScale,2.25,'read restarted after old generation was collected');
});

test('logout during a large snapshot write cannot restore old account data', async () => {
  const s=setup();const image='data:image/png;base64,'+'A'.repeat(340000);
  await s.service.setPortrait(image);
  await s.service.connect(authSecret);
  s.config.set('role',role);
  const storedSet=s.bridge.storage.set;let release,hold=true;
  s.bridge.storage.set=async(key,value)=>{
    if(key.startsWith('endfield.snapshot.chunk.')&&hold){hold=false;await new Promise(resolve=>{release=resolve;});}
    return storedSet(key,value);
  };
  fetchImpl=async()=>({stamina:{current:123,max:240,updatedAt:Date.now()},profile:{name:'old account'},dashboard:{glory:{count:7,medals:[]}}});
  const pending=s.service.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  await globalThis.EndfieldService.create(s.bridge).disconnect();
  release();await pending;
  const value=await s.service.getSnapshot();
  assert.equal(value.stamina,null);
  assert.equal(value.profile,null);
  assert.equal(value.dashboard,null);
  assert.equal(value.portrait.dataUrl,image);
  assert.equal(s.snapshots.at(-1).stamina,null);
});

test('media hydration is optional and cannot turn a successful stamina response into failure', async () => {
  const s=setup();let calls=0;
  await s.service.connect(authSecret);
  fetchImpl=async()=>({stamina:{current:76,max:240,updatedAt:Date.now()},profile:{name:role.name},dashboard:{glory:{count:1,medals:[]}}});
  globalThis.EndfieldMedia={hydrate:async()=>{calls++;throw new Error('image decoder unavailable');}};
  try {
    const result=await s.service.selectRole(role);
    assert.equal(calls,1);
    assert.equal(result.stamina.current,76);
    assert.equal(result.dashboard.glory.count,1);
    assert.equal(result.error,null);
  } finally {delete globalThis.EndfieldMedia;}
});

test('logout in another view during delayed image read invalidates an already validated API result', async () => {
  const s=setup();
  await s.service.connect(authSecret);
  s.config.set('role',role);
  const originalGet=s.bridge.storage.get;
  let release,hold=true;
  s.bridge.storage.get=async key=>{
    if(key==='endfield.portrait'&&hold){hold=false;return new Promise(resolve=>{release=resolve;});}
    return originalGet(key);
  };
  fetchImpl=async()=>({stamina:{current:123,max:240,updatedAt:Date.now()},profile:{name:'old account'}});
  const inflight=s.service.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function','refresh has entered publication');
  const otherView=globalThis.EndfieldService.create(s.bridge);
  await otherView.disconnect();
  release(null);
  await inflight;
  assert.equal(s.snapshots.at(-1).stamina,null);
  assert.equal(s.snapshots.at(-1).profile,null);
  assert.equal(s.storage.has('endfield.auth'),false);
});

test('logout while a new account connection is pending cannot restore credentials', async () => {
  const s=setup(); let resolveConnect;
  connectImpl=()=>new Promise(resolve=>{resolveConnect=resolve;});
  try {
    const pending=s.service.connect(authSecret);
    await new Promise(resolve=>setImmediate(resolve));
    const otherView=globalThis.EndfieldService.create(s.bridge);
    await otherView.disconnect();
    resolveConnect({auth:{accountToken:authSecret},roles:[role]});
    await assert.rejects(pending,error=>error.code==='CANCELLED');
    assert.equal(s.storage.has('endfield.auth'),false);
    assert.equal(s.snapshots.at(-1).stamina,null);
  } finally { connectImpl=null; }
});

test('switching role during an in-flight refresh starts a request for the new role', async () => {
  const s=setup();
  await s.service.connect(authSecret);
  const second=Object.assign({},role,{id:'r2',roleId:'2',name:'new role'});
  s.storage.set('endfield.roles',[role,second]);
  s.config.set('role',role);
  let resolveOld;const fetched=[];
  fetchImpl=async(auth,selected)=>{
    fetched.push(selected.id);
    if(selected.id===role.id)return new Promise(resolve=>{resolveOld=resolve;});
    return {stamina:{current:222,max:240,updatedAt:Date.now()},profile:{name:second.name}};
  };
  const oldRefresh=s.service.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  const switching=s.service.selectRole(second);
  await new Promise(resolve=>setImmediate(resolve));
  resolveOld({stamina:{current:1,max:240,updatedAt:Date.now()},profile:{name:'old'}});
  await oldRefresh;
  const value=await switching;
  assert.deepEqual(fetched,['r1','r2']);
  assert.equal(value.stamina.current,222);
  assert.equal(value.profile.name,second.name);
  assert(s.requests>0,'published API data notifies an awake rear card');
});

test('an appearance save cannot replace a newer API result captured during its image read', async () => {
  const s=setup(); const now=Date.now();
  await s.service.connect(authSecret);
  fetchImpl=async()=>({stamina:{current:10,max:240,updatedAt:now},profile:{name:role.name}});
  await s.service.selectRole(role);
  const originalGet=s.bridge.storage.get;let release,hold=true;
  s.bridge.storage.get=async key=>{
    if(key==='endfield.portrait'&&hold){hold=false;return new Promise(resolve=>{release=resolve;});}
    return originalGet(key);
  };
  const pending=s.service.saveSettings({characterName:'佩丽卡'});
  await new Promise(resolve=>setImmediate(resolve));
  fetchImpl=async()=>({stamina:{current:12,max:240,updatedAt:now+1000},profile:{name:role.name},dashboard:{glory:{count:13,medals:[]},operators:[]}});
  await globalThis.EndfieldService.create(s.bridge).refresh();
  release(null);
  await pending;
  assert.equal(s.snapshots.at(-1).stamina.current,12);
  assert.equal(s.snapshots.at(-1).settings.characterName,'佩丽卡');
  assert.equal(s.snapshots.at(-1).dashboard.glory.count,13);
});

test('a native snapshot save completing after logout is repaired using the current session', async () => {
  const s=setup();
  await s.service.connect(authSecret);
  s.config.set('role',role);
  const originalSave=s.bridge.card.saveSnapshot;let release,hold=true;
  s.bridge.card.saveSnapshot=async value=>{
    if(hold){hold=false;await new Promise(resolve=>{release=resolve;});}
    return originalSave(value);
  };
  fetchImpl=async()=>({stamina:{current:123,max:240,updatedAt:Date.now()},profile:{name:'old account'}});
  const pending=s.service.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  await globalThis.EndfieldService.create(s.bridge).disconnect();
  release();
  await pending;
  assert.equal(s.snapshots.at(-1).stamina,null);
  assert.equal(s.snapshots.at(-1).profile,null);
});

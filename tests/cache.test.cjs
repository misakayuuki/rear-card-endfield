'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/shared/cache.js');
const C = globalThis.EndfieldCache;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAUSURBVAiZYxBJ2dzAwMDAwMQABQAZNQGuHX2ybwAAAABJRU5ErkJggg==';
const webp = 'data:image/webp;base64,UklGRiwCAABXRUJQVlA4WAoAAAAwAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIBQAAAACAAIAAAFZQOCAwAAAA8AEAnQEqAgACAAFAJiWgAnS6AfgABEwAAP7w1wP/SbPE2eJs+SR/87BsS7XgAAAA';

function snapshot(portrait = null, medals = []) {
  return { schemaVersion: 1, settings: { characterName: '佩丽卡 🌌' },
    profile: { name: '昕桃椰椰#1234 · 你好 🌌' },
    stamina: { current: 123, max: 360, updatedAt: 1800000000000 },
    portrait: portrait ? { dataUrl: portrait } : null,
    dashboard: { glory: { displayKnown: true, medals }, operators: [] } };
}
function pad(value, length = 180001) {
  value.padding = '';
  value.padding = '界'.repeat(Math.max(0, length - JSON.stringify(value).length));
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function legacyImage(body, prefix = 'data:image/png;base64,') {
  let pairs='';
  for(let i=0;i<body.length;i+=2)pairs+=String.fromCharCode(0x4000+alphabet.indexOf(body[i])*65+(i+1<body.length?alphabet.indexOf(body[i+1]):0));
  return {endfieldPackedImage:1,prefix,length:body.length,pairs};
}
function codeForSymbol(index) {
  const codes=[];
  for(let code=32;code<=2083;code++)if(![34,47,92,127].includes(code))codes.push(code);
  return codes[index];
}

test('small and legacy snapshots preserve identity, including empty image state', () => {
  const empty = freeze(snapshot());
  assert.equal(C.pack(empty), empty);
  assert.equal(C.unpack(empty), empty);
  const small = freeze(snapshot(png, [{ iconDataUrl: webp }]));
  assert.equal(C.pack(small), small);
  assert.equal(C.unpack(small), small);
  assert.equal(C.unpack(null), null);
  assert.equal(C.unpack('not an object'), null);
  assert.equal(C.unpack([]), null);
});

test('real PNG and transparent WebP images round-trip without mutating frozen sources', () => {
  const original = freeze(pad(snapshot(png, [{ id: 'one', iconDataUrl: webp }])));
  const before = JSON.stringify(original);
  const packed = C.pack(original);
  assert.equal(packed.endfieldPackedSnapshot, 1);
  assert.equal(packed.value.portrait.dataUrl.endfieldPackedImage, 2);
  assert.equal(typeof packed.value.portrait.dataUrl.symbols, 'string');
  const packedBefore = JSON.stringify(packed);
  assert.deepEqual(C.unpack(freeze(packed)), original);
  assert.equal(JSON.stringify(packed), packedBefore);
  assert.equal(JSON.stringify(original), before);
});

test('image conversion shares unchanged metadata and copies only writable image containers', () => {
  const original = pad(snapshot(png, [{ id: 'one', iconDataUrl: webp, detail: { rank: 2 } }]));
  original.dashboard.operators = [{ name: '佩丽卡', equipment: { level: 90 } }];
  Object.defineProperty(original, '__proto__', { value: { sentinel: true }, enumerable: true });
  freeze(original);
  const packed = C.pack(original);
  assert.equal(Object.getPrototypeOf(packed.value), Object.prototype);
  assert.equal(Object.hasOwn(packed.value, '__proto__'), true);
  assert.equal(packed.value.__proto__, original.__proto__);
  for (const value of [packed.value, C.unpack(freeze(packed))]) {
    assert.equal(value.profile, original.profile);
    assert.equal(value.stamina, original.stamina);
    assert.equal(value.settings, original.settings);
    assert.equal(value.dashboard.operators, original.dashboard.operators);
    assert.equal(value.dashboard.glory.medals[0].detail, original.dashboard.glory.medals[0].detail);
    assert.notEqual(value.portrait, original.portrait);
    assert.notEqual(value.dashboard, original.dashboard);
    assert.notEqual(value.dashboard.glory, original.dashboard.glory);
    assert.notEqual(value.dashboard.glory.medals, original.dashboard.glory.medals);
    assert.notEqual(value.dashboard.glory.medals[0], original.dashboard.glory.medals[0]);
  }
  assert.deepEqual(C.unpack(packed), original);
  assert.equal(original.portrait.dataUrl, png);
  assert.equal(original.dashboard.glory.medals[0].iconDataUrl, webp);
  assert.equal(packed.value.portrait.dataUrl.endfieldPackedImage, 2);
});

test('65-symbol base64 alphabet, padding symbols and odd final pairs restore exactly', () => {
  const allPairs = [...alphabet].flatMap(a => [...alphabet].map(b => a + b)).join('');
  for (const body of ['A', 'AA', 'AAA', 'AA==', 'AAA=', '+/=', alphabet, alphabet + '=', allPairs, allPairs + '/']) {
    const value = pad(snapshot('data:image/jpeg;base64,' + body));
    const packed = C.pack(value);
    assert.deepEqual(C.unpack(packed), value);
    const encoded = packed.value.portrait.dataUrl;
    if(encoded.endfieldPackedImage===1){
      assert.equal(encoded.pairs.length, Math.ceil(body.length / 2));
      for (const ch of encoded.pairs) assert(ch.charCodeAt(0) >= 0x4000 && ch.charCodeAt(0) <= 0x5080);
    }else{
      assert.equal(encoded.endfieldPackedImage,2);
      assert.equal(encoded.symbols.length,Math.ceil((body.length-encoded.padding)*6/11));
    }
  }
});

test('maximum portrait and ten full-size medal icons fit the UTF-16 Binder envelope', () => {
  const portraitPrefix = 'data:image/webp;base64,';
  const iconPrefix = 'data:image/png;base64,';
  const value = snapshot(portraitPrefix + '/'.repeat(480000 - portraitPrefix.length),
    Array.from({ length: 10 }, (_, index) => ({ id: '章' + index, iconDataUrl: iconPrefix + '+'.repeat(24000 - iconPrefix.length) })));
  value.metadata = '养成'.repeat(12000);
  assert(JSON.stringify(value).length < 760000);
  const packed = C.pack(freeze(value));
  assert(JSON.stringify(packed).length < 450000);
  const outbox = { id: 'native-command-123456789', method: 'card.saveSnapshot', args: [packed] };
  const carrier = JSON.stringify({ outbox: JSON.stringify([outbox]) });
  assert(carrier.length * 2 + 16384 < 1024 * 1024, 'full JSON envelope retains Binder headroom');
  assert.deepEqual(C.unpack(packed), value);
});

test('large image-free snapshots round-trip and the uncompressed threshold is exact', () => {
  const at = pad(snapshot(), 180000);
  assert.equal(C.pack(at), at);
  const over = pad(snapshot(), 180001);
  assert.equal(C.pack(over).endfieldPackedSnapshot, 1);
  assert.deepEqual(C.unpack(C.pack(over)), over);
});

test('malformed markers, mime, length, codepoints and odd-pair padding fail closed', () => {
  const initial = {endfieldPackedSnapshot:1,value:pad(snapshot())};
  initial.value.portrait={dataUrl:legacyImage('AAA')};
  assert.equal(C.unpack(initial).portrait.dataUrl,'data:image/png;base64,AAA','v1 snapshots remain readable');
  const mutations = [
    p => { p.endfieldPackedSnapshot = 2; },
    p => { p.extra = 1; },
    p => { p.value = null; },
    p => { p.value.endfieldPackedSnapshot = 1; },
    p => { p.value.portrait.dataUrl.endfieldPackedImage = 2; },
    p => { p.value.portrait.dataUrl.prefix = 'data:image/svg+xml;base64,'; },
    p => { p.value.portrait.dataUrl.prefix = 'https://example.com/'; },
    p => { p.value.portrait.dataUrl.length = 3.5; },
    p => { p.value.portrait.dataUrl.length = -1; },
    p => { p.value.portrait.dataUrl.length = 0; },
    p => { p.value.portrait.dataUrl.length = 480000; },
    p => { p.value.portrait.dataUrl.pairs = p.value.portrait.dataUrl.pairs.slice(1); },
    p => { p.value.portrait.dataUrl.pairs = '\u3fff\u4000'; },
    p => { p.value.portrait.dataUrl.pairs = '\u5081\u4000'; },
    p => { p.value.portrait.dataUrl.pairs = '\ud800\u4000'; },
    p => { p.value.portrait.dataUrl.pairs = '\u2028\u4000'; },
    p => { p.value.portrait.dataUrl.pairs = '\u4000\u4001'; },
    p => { p.value.portrait.dataUrl.extra = ''; },
    p => { p.value.portrait.dataUrl = png; }
  ];
  for (const mutate of mutations) { const copy = clone(initial); mutate(copy); assert(C.unpack(copy)===null); }
  for (const bad of ['data:image/svg+xml;base64,AAAA', 'data:image/png;base64,A A', 'data:image/png;base64,', 'http://example.com/image.png', {}]) {
    const value = snapshot(png); value.portrait.dataUrl = bad;
    assert.throws(() => C.pack(value), e => e.code === 'SNAPSHOT_FORMAT');
    assert.equal(C.unpack(value), value, 'legacy invalid artwork does not discard usable player data');
  }
});

test('native, decoded, per-image and total-icon limits are enforced before publication', () => {
  assert.throws(() => C.pack(pad(snapshot(), 760001)), e => e.code === 'SNAPSHOT_SIZE');
  assert.throws(() => C.pack(pad(snapshot(), 450001)), e => e.code === 'SNAPSHOT_SIZE');
  const largeLegacy = pad(snapshot(), 760000);
  assert.equal(C.unpack(largeLegacy), largeLegacy);
  assert.equal(C.unpack(pad(snapshot(), 760001)), null);
  assert.throws(() => C.pack(snapshot('data:image/png;base64,' + 'A'.repeat(480000))), e => e.code === 'SNAPSHOT_SIZE');
  assert.throws(() => C.pack(snapshot(null, [{ iconDataUrl: 'data:image/png;base64,' + 'A'.repeat(24000) }])), e => e.code === 'SNAPSHOT_SIZE');
  const icon = 'data:image/png;base64,' + 'A'.repeat(23978);
  assert.throws(() => C.pack(snapshot(null, Array.from({ length: 11 }, () => ({ iconDataUrl: icon })))), e => e.code === 'SNAPSHOT_SIZE');
  const packed = C.pack(snapshot('data:image/png;base64,' + 'A'.repeat(479978)));
  packed.value.padding = 'x'.repeat(280001);
  assert.equal(C.unpack(packed), null);
  const circular = snapshot(); circular.self = circular;
  assert.throws(() => C.pack(circular), e => e.code === 'SNAPSHOT_FORMAT');
  assert.equal(C.unpack(circular), null);
});

test('v2 all 2048 symbols survive UTF-8 and Android JSON escaping exactly', () => {
  let bits=0,available=0,body='';
  for(let word=0;word<2048;word++){
    bits=(bits<<11)|word;available+=11;
    while(available>=6){available-=6;body+=alphabet[(bits>>>available)&63];}
    bits&=(1<<available)-1;
  }
  if(available)body+=alphabet[bits<<(6-available)];
  const value=pad(snapshot('data:image/png;base64,'+body));
  const packed=C.pack(value), image=packed.value.portrait.dataUrl;
  assert.equal(image.endfieldPackedImage,2);
  const codes=new Set([...image.symbols].map(character=>character.charCodeAt(0)));
  assert.equal(codes.size,2048);
  for(const code of codes)assert(code>=32&&code<=2083&&![34,47,92,127].includes(code));
  const transported=JSON.parse(Buffer.from(JSON.stringify(packed).replaceAll('/','\\/'),'utf8').toString('utf8'));
  assert.deepEqual(C.unpack(transported),value);
});

test('v2 bit boundaries and suffix padding round-trip independently of byte alignment', () => {
  let seed=123456789;
  for(let length=1;length<=66;length++){
    let body='';
    for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;body+=alphabet[seed>>>26];}
    body+='='.repeat(length%3);
    const value=pad(snapshot('data:image/jpeg;base64,'+body));
    const packed=C.pack(value);
    assert.equal(packed.value.portrait.dataUrl.endfieldPackedImage,2);
    assert.deepEqual(C.unpack(packed),value);
  }
  for(const body of ['=','==','===','A===','A=A','==A','A==A=']){
    const value=pad(snapshot('data:image/png;base64,'+body));
    const packed=C.pack(value);
    assert.equal(packed.value.portrait.dataUrl.endfieldPackedImage,1);
    assert.deepEqual(C.unpack(packed),value);
  }
});

test('v2 rejects malformed shift, padding, alphabet and nonzero unused bits', () => {
  const initial=C.pack(pad(snapshot('data:image/png;base64,A')));
  const mutations=[
    image=>{image.endfieldPackedImage=3;},
    image=>{image.padding=-1;},image=>{image.padding=3;},image=>{image.padding=0.5;},image=>{image.padding=1;},
    image=>{image.shift=-1;},image=>{image.shift=2048;},image=>{image.shift=1.5;},
    image=>{delete image.shift;},image=>{image.extra=0;},
    image=>{image.symbols+=' ';},image=>{image.symbols='';},
    ...[0,31,34,47,92,127,2084,0xd800,0x2028].map(code=>image=>{image.symbols=String.fromCharCode(code);}),
    image=>{image.symbols=String.fromCharCode(codeForSymbol((image.shift+1)&2047));}
  ];
  for(const mutate of mutations){const packed=clone(initial);mutate(packed.value.portrait.dataUrl);assert(C.unpack(packed)===null);}
});

test('v2 rotation bounds UTF-8 bytes for random and adversarial repetitive large images', () => {
  const length=480000-'data:image/webp;base64,'.length;
  let seed=987654321,random='';
  for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;random+=alphabet[seed>>>26];}
  for(const body of ['/'.repeat(length),'+/'.repeat(Math.ceil(length/2)).slice(0,length),'A'.repeat(length),random]){
    const value=snapshot('data:image/webp;base64,'+body);
    const packed=C.pack(value), image=packed.value.portrait.dataUrl;
    assert.equal(image.endfieldPackedImage,2);
    assert(Buffer.byteLength(image.symbols)*256<=image.symbols.length*505,'rotation never exceeds the uniform alphabet UTF-8 cost');
    assert.deepEqual(C.unpack(packed),value);
  }
});

test('outbound native UTF-8 limit includes Android slash escaping and does not truncate metadata', () => {
  const limit=802000;
  const value=snapshot();
  value.padding='PRIVATE_SENTINEL/'+'/'.repeat(100000)+'é🌌'.repeat(1000);
  const androidBytes=value=>Buffer.byteLength(JSON.stringify(value).replaceAll('/','\\/'),'utf8');
  const remaining=limit-androidBytes({endfieldPackedSnapshot:1,value});
  value.padding+='界'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3);
  const before=JSON.stringify(value);
  const packed=C.pack(freeze(value));
  assert.equal(androidBytes(packed),limit);
  assert(JSON.stringify(packed).length<450000,'UTF-8 boundary is distinct from the UTF-16 character limit');
  assert.deepEqual(C.unpack(packed),value);
  assert.equal(JSON.stringify(value),before);

  const over=clone(value);over.padding+='x';freeze(over);
  assert.throws(()=>C.pack(over),failure=>failure.code==='SNAPSHOT_SIZE'&&
    failure.message==='背屏快照超过容量，请缩小图片后再保存。');
  assert.equal(over.padding,value.padding+'x','rejection does not truncate the source');
  const legacy={endfieldPackedSnapshot:1,value:over};
  assert.deepEqual(C.unpack(legacy),over,'the outbound byte ceiling does not invalidate old snapshots');
});

test('oversized v1 fallback images are rejected before publication while old native copies remain readable', () => {
  const prefix='data:image/png;base64,';
  const body=length=>'=A'.repeat(Math.ceil(length/2)).slice(0,length);
  const value=freeze(snapshot(prefix+body(480000-prefix.length),
    Array.from({length:10},()=>({iconDataUrl:prefix+body(24000-prefix.length)}))));
  const before=JSON.stringify(value);
  const legacy={endfieldPackedSnapshot:1,value:clone(value)};
  legacy.value.portrait.dataUrl=legacyImage(value.portrait.dataUrl.slice(prefix.length));
  legacy.value.dashboard.glory.medals.forEach((medal,index)=>{
    medal.iconDataUrl=legacyImage(value.dashboard.glory.medals[index].iconDataUrl.slice(prefix.length));
  });
  assert(JSON.stringify(legacy).length<450000);
  assert(Buffer.byteLength(JSON.stringify(legacy),'utf8')>802000);
  assert.throws(()=>C.pack(value),failure=>failure.code==='SNAPSHOT_SIZE'&&
    failure.message==='背屏快照超过容量，请缩小图片后再保存。');
  assert.equal(JSON.stringify(value),before);
  assert.deepEqual(C.unpack(legacy),value);
});

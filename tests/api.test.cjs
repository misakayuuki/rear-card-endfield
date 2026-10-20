const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const CryptoJS = require('crypto-js');

function load() {
  const context = vm.createContext({ CryptoJS, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared/api.js'), 'utf8'), context);
  return context.EndfieldAPI;
}
const A = load();
const auth = { accountToken: 'test-account-token', cred: 'test-cred', signToken: 'test-key', userId: 'skland-identity' };
const role = { id: 'role:1', uid: 'binding-identity', roleId: 'role', serverId: '1', name: '测试管理员', server: '国服' };
function ok(data, envelope = 'code') { return { status: 200, body: JSON.stringify({ [envelope]: 0, data }), headers: {} }; }
const detail = { detail: { currentTs: '1770000000', dungeon: { curStamina: '0', maxStamina: '240', maxTs: '1770086400' },
  base: { name: '测试管理员', level: 20, serverName: 'China' },
  chars: [{ charData: { id: 'char-test', name: '测试干员', illustrationUrl: 'https://example.com/portrait.png' } }] } };

test('signature matches independent Node HMAC/MD5 including encoded GET query', () => {
  const requestPath = '/web/v1/game/endfield/card/detail';
  const query = 'roleId=a%2Bb&serverId=1&userId=skland-identity';
  const timestamp = '1770000000';
  const headers = A.signedHeaders(auth, requestPath, query, timestamp);
  const input = requestPath + query + timestamp + '{"platform":"","timestamp":"1770000000","dId":"","vName":""}';
  const hmac = crypto.createHmac('sha256', 'test-key').update(input).digest('hex');
  assert.equal(headers.sign, crypto.createHash('md5').update(hmac).digest('hex'));
  assert.equal(headers.cred, auth.cred);
});

test('account/info JSON and plain token are accepted, empty JSON and URLs are not', () => {
  assert.equal(A.parseAccountToken('  test-token '), 'test-token');
  assert.equal(A.parseAccountToken('{"code":0,"data":{"content":"test-token"}}'), 'test-token');
  for (const value of ['', '{}', 'https://web-api.skland.com/account/info/hg', '{broken', 'a\nb']) {
    assert.throws(() => A.parseAccountToken(value), e => e.code === 'INPUT');
  }
});

test('roles come from Endfield nested roles and retain distinct binding uid', () => {
  const data = { list: [
    { appCode: 'arknights', bindingList: [{ uid: 'ark', roles: [{ roleId: 'wrong', serverId: '1' }] }] },
    { appCode: 'endfield', bindingList: [{ uid: 'binding-uid', roles: [
      { roleId: 'ef-role', serverId: '1', nickname: '玩家', serverName: 'China' },
      { roleId: 'ef-role', serverId: '1' }, { roleId: 'banned', serverId: '1', isBanned: true }
    ] }] }
  ] };
  const roles = A.parseRoles(data);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].roleId, 'ef-role');
  assert.equal(roles[0].uid, 'binding-uid');
  assert.equal(roles[0].server, '国服');
});

test('zero stamina is valid, server timestamps use milliseconds and missing values fail', () => {
  const result = A.normalizeDetail(detail, role);
  assert.equal(result.stamina.current, 0);
  assert.equal(result.stamina.updatedAt, 1770000000000);
  assert.equal(result.stamina.recoveryAt, 1770086400000);
  assert.equal(result.stamina.secondsPerPoint, null);
  assert.equal(result.characters[0].name, '测试干员');
  assert.throws(() => A.normalizeDetail({ detail: { dungeon: {} } }, role), e => e.code === 'DATA');
  const overflow = A.normalizeDetail({ detail: { dungeon: { curStamina: '300', maxStamina: '240', maxTs: '0' } } }, role, 100);
  assert.equal(overflow.stamina.current, 300);
  assert.equal(overflow.stamina.recoveryAt, null);
});

test('dashboard uses observed achievement and character fields, preserving zero and missing values', () => {
  const input = structuredClone(detail);
  input.detail.base.charNum = '0';
  input.detail.achieve = { count: '0', display: { 1: 'medal-1', 2: 'medal-2' }, achieveMedals: [
    { level: 0, isPlated: false, achievementData: { id: 'medal-1', name: '测试奖章', cateName: '探索', initLevel: 2 } },
    { achievementData: { id: 'medal-2', name: '另一奖章', initLevel: 2 } }
  ] };
  input.detail.chars = [{
    charData: { id: 'operator-1', name: '测试干员', rarity: { value: '6' }, skills: [
      { id: 'skill-1', name: '测试技能' }, { id: 'skill-2', name: '未返回等级的技能' }
    ] },
    level: '0', evolvePhase: 0, potentialLevel: 0, userSkills: { 'skill-1': { level: 0 } },
    weapon: { weaponData: { name: '测试武器' }, level: 0, refineLevel: 0 },
    bodyEquip: { equipData: { name: '测试装备', level: { value: '0' } } }
  }];
  const dashboard = A.normalizeDetail(input, role).dashboard;
  assert.equal(dashboard.glory.count, 0);
  assert.equal(dashboard.glory.displayKnown, true);
  assert.equal(dashboard.glory.displayCount, 2);
  assert.equal(dashboard.glory.medals[0].level, 0);
  assert.equal(dashboard.glory.medals[0].isPlated, false);
  assert.equal(dashboard.glory.medals[1].level, null, 'initial medal level must not substitute for a missing player level');
  assert.equal(dashboard.glory.medals[1].isPlated, null);
  assert.equal(dashboard.operatorCount, 0);
  const operator = dashboard.operators[0];
  assert.equal(operator.level, 0);
  assert.equal(operator.evolvePhase, 0);
  assert.equal(operator.potentialLevel, 0);
  assert.equal(operator.rarity, '6');
  assert.equal(operator.weapon.level, 0);
  assert.equal(operator.weapon.refineLevel, 0);
  assert.equal(operator.weapon.breakthroughLevel, null);
  assert.equal(operator.skills[0].level, 0);
  assert.equal(operator.skills[1].level, null);
  assert.equal(operator.equipment[0].slot, 'bodyEquip');
  assert.equal(operator.equipment[0].level, '0');
});

test('missing or malformed optional dashboard data never turns into zero or discards stamina', () => {
  const result = A.normalizeDetail(detail, role);
  assert.equal(result.dashboard.glory, null);
  assert.equal(result.dashboard.operatorCount, null);
  assert.equal(result.dashboard.operators[0].level, null);
  assert.equal(result.dashboard.operators[0].weapon, null);
  for (const bad of [undefined, null, '', ' ', false, [], {}, 'Infinity', -1, 1.5]) {
    const input = structuredClone(detail);
    input.detail.base.charNum = bad;
    input.detail.achieve = { count: bad, achieveMedals: [null, false, { achievementData: [] }] };
    input.detail.chars = [null, 0, [], { charData: [] }, { charData: { id: 'operator-1', name: '测试干员' }, level: bad }];
    const normalized = A.normalizeDetail(input, role);
    assert.equal(normalized.stamina.current, 0);
    assert.equal(normalized.dashboard.operatorCount, null);
    assert.equal(normalized.dashboard.glory.count, null);
    assert.equal(normalized.dashboard.glory.medals.length, 0);
    assert.equal(normalized.dashboard.operators[0].level, null);
  }
});

test('dashboard bounds multibyte data and excludes payloads, unselected image URLs and private fields', () => {
  const input = structuredClone(detail), longName = '很长的中文名称😀'.repeat(200);
  input.detail.base.charNum = 200;
  input.detail.achieve = { count: 200, secret: 'PRIVATE_RESPONSE', display: Object.fromEntries(Array.from({length:40}, (_, i) => [i+1,'medal-'+i])), achieveMedals: Array.from({ length: 200 }, (_, i) => ({
    level: 1, achievementData: { id: 'medal-' + i, name: longName, cateName: longName,
      initIcon: i < 40 ? 'https://cdn.example/medal.png' : 'https://private.invalid/PRIVATE_RESPONSE' }
  })) };
  input.detail.chars = Array.from({ length: 200 }, (_, i) => ({
    id: 'private-player-instance', ownTs: 'PRIVATE_RESPONSE', level: 60,
    charData: { id: 'operator-' + i, name: longName, rarity: { value: '6' },
      skills: Array.from({ length: 20 }, (_, j) => ({ id: 'skill-' + j, name: longName, desc: 'PRIVATE_RESPONSE'.repeat(1000) })) },
    weapon: { weaponData: { name: longName, desc: 'PRIVATE_RESPONSE'.repeat(1000) } },
    bodyEquip: { equipData: { name: longName, level: { value: '50' }, subEntries: ['PRIVATE_RESPONSE'] } }
  }));
  const dashboard = A.normalizeDetail(input, role).dashboard;
  const json = JSON.stringify(dashboard);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 24 * 1024);
  assert.ok(dashboard.operators.length > 0 && dashboard.operators.length <= 64);
  assert.equal(dashboard.glory.medals.length, 32);
  assert.equal(dashboard.operatorsTruncated, true);
  assert.equal(dashboard.medalsTruncated, true);
  assert.equal(dashboard.operatorCount, 200);
  assert.equal(dashboard.glory.count, 200);
  assert.equal(dashboard.glory.displayCount, 40);
  assert.equal(dashboard.operators[0].skills.length, 8);
  assert.ok(!json.includes('PRIVATE_RESPONSE'));
  assert.ok(json.includes('https://cdn.example/medal.png'));
  assert.ok(!json.includes('private-player-instance'));
});

test('etching showcase follows selected slot order and chooses the achieved artwork variant', () => {
  const input = structuredClone(detail);
  const icons = {initIcon:'https://cdn.example/init.png',platedIcon:'https://cdn.example/plated.png',
    reforge2Icon:'https://cdn.example/reforge2.png',reforge3Icon:'https://cdn.example/reforge3.png'};
  input.detail.achieve = {count:50,display:{10:'three',2:'two',1:'plated',3:'missing',4:'unsafe'},achieveMedals:[
    {level:3,isPlated:true,achievementData:{id:'three',name:'三级',...icons}},
    {level:2,isPlated:true,achievementData:{id:'two',name:'二级',...icons}},
    {level:1,isPlated:true,achievementData:{id:'plated',name:'镀层',...icons}},
    {level:2,achievementData:{id:'unsafe',name:'安全回退',reforge2Icon:'http://cdn.example/plain.png',initIcon:icons.initIcon}},
    {level:3,achievementData:{id:'unselected',name:'不能展示',...icons}}
  ]};
  const glory = A.normalizeDetail(input, role).dashboard.glory;
  assert.deepEqual(Array.from(glory.medals, medal=>medal.id), ['plated','two','missing','unsafe','three']);
  assert.deepEqual(Array.from(glory.medals, medal=>medal.slot), ['1','2','3','4','10']);
  assert.deepEqual(Array.from(glory.medals, medal=>medal.iconUrl), [icons.platedIcon,icons.reforge2Icon,null,icons.initIcon,icons.reforge3Icon]);
  assert.equal(glory.medals[2].name, '');
  assert.equal(glory.displayCount, 5);
  assert.ok(!JSON.stringify(glory).includes('unselected'));
});

test('missing or empty showcase never falls back to all acquired medals', () => {
  const input = structuredClone(detail);
  input.detail.achieve = {count:10,achieveMedals:[{level:1,achievementData:{id:'medal-1',name:'已获得'}}]};
  let glory = A.normalizeDetail(input, role).dashboard.glory;
  assert.equal(glory.displayKnown, false);
  assert.equal(glory.displayCount, null);
  assert.equal(glory.medals.length, 0);
  input.detail.achieve.display = {};
  glory = A.normalizeDetail(input, role).dashboard.glory;
  assert.equal(glory.displayKnown, true);
  assert.equal(glory.displayCount, 0);
  assert.equal(glory.medals.length, 0);
  input.detail.achieve.display = {type:1,achieveMedalId:'medal-1'};
  glory = A.normalizeDetail(input, role).dashboard.glory;
  assert.equal(glory.displayKnown, true);
  assert.equal(glory.medals[0].id, 'medal-1');
  assert.equal(glory.medals[0].iconUrl, null);
  input.detail.achieve.display = {arbitrary:'medal-1'};
  glory = A.normalizeDetail(input, role).dashboard.glory;
  assert.equal(glory.displayKnown, false);
  assert.equal(glory.medals.length, 0);
  input.detail.achieve.display = {1:{id:'medal-1'}};
  glory = A.normalizeDetail(input, role).dashboard.glory;
  assert.equal(glory.displayKnown, false, 'malformed values must not be reported as a known empty showcase');
  assert.equal(glory.displayCount, null);
});

test('connect performs official grant, credential exchange, identity lookup and binding', async () => {
  const calls = [];
  const responses = [ok({ code: 'test-grant' }, 'status'), ok({ cred: auth.cred, token: auth.signToken }),
    ok({ teenager: { userId: 'skland-identity' } }), ok({ list: [] })];
  const api = A.create({ net: { request: async args => { calls.push(args); return responses.shift(); } } });
  const result = await api.connect('test-account-token');
  assert.equal(result.auth.userId, 'skland-identity');
  assert.equal(calls[0].url, 'https://as.hypergryph.com/user/oauth2/v2/grant');
  assert.deepEqual(JSON.parse(calls[0].body), { appCode: '4ca99fa6b56cc2ba', token: 'test-account-token', type: 0 });
  assert.equal(calls[1].url, 'https://zonai.skland.com/api/v1/user/auth/generate_cred_by_code');
  assert.equal(calls[2].url, 'https://zonai.skland.com/api/v1/user/teenager');
  assert.equal(calls[3].url, 'https://zonai.skland.com/api/v1/game/player/binding');
  assert.ok(calls.every(call => call.redirect === 'manual'));
});

test('refresh signs with new key and sends Skland userId, not binding uid', async () => {
  const calls = [];
  const responses = [ok({ token: 'rotated-key' }), ok(detail)];
  const api = A.create({ net: { request: async args => { calls.push(args); return responses.shift(); } } });
  const result = await api.fetchStamina(auth, role);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://zonai.skland.com/web/v1/game/endfield/card/detail?roleId=role&serverId=1&userId=skland-identity');
  const parsed = new URL(calls[1].url);
  const expected = A.signedHeaders({ ...auth, signToken: 'rotated-key' }, parsed.pathname, parsed.search.slice(1), calls[1].headers.timestamp);
  assert.equal(calls[1].headers.sign, expected.sign);
  assert.equal(result.auth.signToken, 'rotated-key');
  assert.equal(auth.signToken, 'test-key');
  assert.equal(result.dashboard.operators[0].name, '测试干员');
  assert.equal(result.dashboard.glory, null);
});

test('extra-data absence still returns stamina using only the existing refresh and detail requests', async () => {
  let calls = 0;
  const minimal = { detail: { dungeon: { curStamina: '10', maxStamina: '240' }, achieve: null, chars: null } };
  const responses = [ok({ token: 'rotated-key' }), ok(minimal)];
  const api = A.create({ net: { request: async () => {
    calls++;
    if (!responses.length) throw Object.assign(new Error('optional endpoint failure'), { code: 'TIMEOUT' });
    return responses.shift();
  } } });
  const result = await api.fetchStamina(auth, role);
  assert.equal(calls, 2, 'dashboard extraction must not introduce optional network requests');
  assert.equal(result.stamina.current, 10);
  assert.equal(result.dashboard.glory, null);
  assert.equal(result.dashboard.operators.length, 0);
});

test('timeout and network failure are not replayed or exposed as raw errors', async () => {
  for (const code of ['TIMEOUT', 'SOMETHING']) {
    let calls = 0;
    const api = A.create({ net: { request: async () => { calls++; throw Object.assign(new Error('SECRET-token'), { code }); } } });
    await assert.rejects(api.fetchStamina(auth, role), e => !e.message.includes('SECRET') && e.code === (code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK'));
    assert.equal(calls, 1);
  }
});

test('only explicit auth rejection triggers account-token exchange', async () => {
  const calls = [];
  const responses = [{ status: 200, body: JSON.stringify({ code: 10002, message: 'SECRET-response' }), headers: {} },
    ok({ code: 'test-grant' }, 'status'), ok({ cred: 'new-cred', token: 'new-key', userId: 'skland-identity' }), ok(detail)];
  const api = A.create({ net: { request: async args => { calls.push(args); return responses.shift(); } } });
  const result = await api.fetchStamina(auth, role);
  assert.equal(calls.length, 4);
  assert.equal(result.auth.cred, 'new-cred');
  const failed = A.create({ net: { request: async () => ({ status: 200, body: JSON.stringify({ code: 999, message: 'SECRET-response' }) }) } });
  await assert.rejects(failed.fetchStamina(auth, role), e => e.code === 'API' && !e.message.includes('SECRET'));
});

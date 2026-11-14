'use strict';
// Run with: node --test node/paprika-mcp.test.js
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { PaprikaClient, RecipeServer, recipeHash } = require('./paprika-mcp.js');

function fakeApi(recipes, categories = [{ uid: 'CAT1', name: 'Soups', order_flag: 0, parent_uid: null }]) {
  const calls = [];
  calls.categories = categories;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, init });
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
    if (url.endsWith('/v1/account/login')) {
      calls.loginBody = init.body;
      return ok({ token: 'T' });
    }
    if (url.endsWith('/v2/sync/recipes/')) return ok(Object.values(recipes).map((r) => ({ uid: r.uid, hash: r.hash })));
    if (url.endsWith('/v2/sync/notify/')) return ok(true);
    if (url.endsWith('/v2/sync/categories/') && init.method === 'GET') return ok(JSON.parse(JSON.stringify(categories)));
    if (url.endsWith('/v2/sync/categories/') && init.method === 'POST') {
      const file = init.body.get('data');
      const posted = JSON.parse(zlib.gunzipSync(Buffer.from(await file.arrayBuffer())).toString());
      calls.postedCategories = posted;
      categories.push(...posted);
      return ok(true);
    }
    const m = url.match(/\/v2\/sync\/recipe\/([^/]+)\/$/);
    if (m && init.method === 'GET') return ok(JSON.parse(JSON.stringify(recipes[decodeURIComponent(m[1])])));
    if (m && init.method === 'POST') {
      const file = init.body.get('data');
      const saved = JSON.parse(zlib.gunzipSync(Buffer.from(await file.arrayBuffer())).toString());
      calls.saved = calls.saved || [];
      calls.saved.push(saved);
      recipes[saved.uid] = saved;
      return ok(true);
    }
    return { ok: false, status: 404, json: async () => null };
  };
  return { fetchImpl, calls };
}

function fixture() {
  return {
    DAL: { uid: 'DAL', name: 'Masoor dal', ingredients: 'red lentils\npotato', notes: 'Yukon Gold for sweet potato', rating: 4,
      categories: ['CAT1'], photo: 'dal.jpg', source: 'NYT Cooking', photos: [{ n: 1 }], future_field: 42, hash: 'h1',
      created: '2026-11-08 18:00:00', in_trash: false },
    SOUP: { uid: 'SOUP', name: 'Spicy coconut chicken noodle soup', ingredients: 'chicken\nrice ramen', source: "America's Test Kitchen", hash: 'h2', in_trash: false },
    TRASH: { uid: 'TRASH', name: 'Old lentil thing', ingredients: 'lentils', in_trash: true, hash: 'h3' },
  };
}

function setup() {
  const recipes = fixture();
  const api = fakeApi(recipes);
  const client = new PaprikaClient({ username: 'a@b.com', password: 'p&ss+w=rd', fetchImpl: api.fetchImpl });
  return { recipes, api, server: new RecipeServer(client) };
}

const call = (server, name, args) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('update changes only given fields and keeps everything else', async () => {
  const { api, server } = setup();
  const res = await call(server, 'update_paprika_recipe', { uid: 'DAL', append_notes: "Tiffani: coconut milk in her bowl only." });
  assert.ok(!res.result.isError, res.result.content[0].text);
  const s = api.calls.saved[0];
  assert.strictEqual(s.rating, 4);
  assert.strictEqual(s.photo, 'dal.jpg');
  assert.deepStrictEqual(s.categories, ['CAT1']);
  assert.deepStrictEqual(s.photos, [{ n: 1 }]);
  assert.strictEqual(s.future_field, 42);
  assert.strictEqual(s.ingredients, 'red lentils\npotato');
  assert.strictEqual(s.created, '2026-11-08 18:00:00');
  assert.strictEqual(s.notes, 'Yukon Gold for sweet potato\n\nTiffani: coconut milk in her bowl only.');
  assert.notStrictEqual(s.hash, 'h1');
  assert.strictEqual(s.hash, recipeHash(s));
});

test('update refuses trash, empty updates and empty names, saving nothing', async () => {
  const { api, server } = setup();
  for (const args of [{ uid: 'TRASH', notes: 'x' }, { uid: 'DAL' }, { uid: 'DAL', name: '' }]) {
    const res = await call(server, 'update_paprika_recipe', args);
    assert.ok(res.result.isError, JSON.stringify(args));
  }
  assert.strictEqual(api.calls.saved, undefined);
});

test('search skips trash and requires all words', async () => {
  const { server } = setup();
  let out = (await call(server, 'search_paprika_recipes', { query: 'lentils' })).result.content[0].text;
  assert.match(out, /Masoor dal/);
  assert.doesNotMatch(out, /Old lentil/);
  out = (await call(server, 'search_paprika_recipes', { query: 'chicken ramen' })).result.content[0].text;
  assert.match(out, /noodle soup/);
  assert.doesNotMatch(out, /dal/);
  out = (await call(server, 'search_paprika_recipes', {})).result.content[0].text;
  assert.match(out, /2 of 2 recipes/);
});

test('cache refetches only changed recipes, including trashed ones', async () => {
  const { recipes, api, server } = setup();
  await server.refresh(true);
  const gets = () => api.calls.filter((c) => c.method === 'GET' && /recipe\/[^/]+\/$/.test(c.url)).length;
  const first = gets();
  await server.refresh(true);
  assert.strictEqual(gets(), first);
  recipes.SOUP.hash = 'h2b';
  await server.refresh(true);
  assert.strictEqual(gets(), first + 1);
});

test('create requires core fields, fills defaults, uppercases uid', async () => {
  const { api, server } = setup();
  let res = await call(server, 'create_paprika_recipe', { name: 'x' });
  assert.ok(res.result.isError);
  res = await call(server, 'create_paprika_recipe', { name: 'One-pot chicken', ingredients: 'a', directions: 'b', source: 'House' });
  assert.ok(!res.result.isError, res.result.content[0].text);
  const s = api.calls.saved[0];
  assert.strictEqual(s.source, 'House');
  assert.strictEqual(s.uid, s.uid.toUpperCase());
  assert.deepStrictEqual(s.categories, []);
  assert.ok(s.created);
});

test('login URL-encodes the password', async () => {
  const { api, server } = setup();
  await call(server, 'search_paprika_recipes', {});
  assert.match(api.calls.loginBody, /password=p%26ss%2Bw%3Drd/);
});

test('protocol: initialize, tools/list without delete, notifications get no reply', async () => {
  const { server } = setup();
  const init = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(init.result.protocolVersion, '2025-06-18');
  assert.strictEqual(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names.sort(), ['create_paprika_category', 'create_paprika_recipe', 'get_paprika_recipe', 'list_paprika_categories', 'search_paprika_recipes', 'update_paprika_recipe']);
  assert.ok(!names.some((n) => n.includes('delete')));
});

test('only paprikaapp.com is contacted', async () => {
  const { api, server } = setup();
  await call(server, 'search_paprika_recipes', {});
  await call(server, 'update_paprika_recipe', { uid: 'DAL', rating: 5 });
  for (const c of api.calls) assert.match(c.url, /^https:\/\/paprikaapp\.com\/api\//);
});

test('create category, refuse duplicate', async () => {
  const { api, server } = setup();
  let res = await call(server, 'create_paprika_category', { name: 'GF/DF' });
  assert.ok(!res.result.isError, res.result.content[0].text);
  assert.strictEqual(api.calls.postedCategories[0].name, 'GF/DF');
  assert.match(api.calls.postedCategories[0].uid, /^[0-9A-F-]{36}$/);
  res = await call(server, 'create_paprika_category', { name: 'soups' });
  assert.ok(res.result.isError);
});

test('categories: set, add, remove keep other fields; unknown names save nothing', async () => {
  const { api, server } = setup();
  await call(server, 'create_paprika_category', { name: 'GF/DF' });
  await call(server, 'create_paprika_category', { name: 'Vegetarian & Beans' });
  let res = await call(server, 'update_paprika_recipe', { uid: 'DAL', add_categories: ['GF/DF', 'vegetarian & beans'] });
  assert.ok(!res.result.isError, res.result.content[0].text);
  let s = api.calls.saved.at(-1);
  assert.strictEqual(s.categories.length, 3);
  assert.strictEqual(s.categories[0], 'CAT1');
  assert.strictEqual(s.rating, 4);
  assert.strictEqual(s.notes, 'Yukon Gold for sweet potato');
  assert.match(res.result.content[0].text, /categories: Soups, GF\/DF, Vegetarian & Beans/);

  res = await call(server, 'update_paprika_recipe', { uid: 'DAL', remove_categories: ['Soups'] });
  s = api.calls.saved.at(-1);
  assert.ok(!s.categories.includes('CAT1'));

  res = await call(server, 'update_paprika_recipe', { uid: 'DAL', set_categories: ['Soups'] });
  assert.deepStrictEqual(api.calls.saved.at(-1).categories, ['CAT1']);

  const before = api.calls.saved.length;
  res = await call(server, 'update_paprika_recipe', { uid: 'DAL', add_categories: ['Nope'] });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /unknown categories: Nope/);
  assert.strictEqual(api.calls.saved.length, before);
});

test('search by category and list counts', async () => {
  const { server } = setup();
  let out = (await call(server, 'search_paprika_recipes', { category: 'soups' })).result.content[0].text;
  assert.match(out, /Masoor dal/);
  assert.doesNotMatch(out, /noodle soup/);
  out = (await call(server, 'search_paprika_recipes', { category: '(none)' })).result.content[0].text;
  assert.match(out, /noodle soup/);
  assert.doesNotMatch(out, /Masoor/);
  const bad = await call(server, 'search_paprika_recipes', { category: 'Nope' });
  assert.ok(bad.result.isError);
  out = (await call(server, 'list_paprika_categories', {})).result.content[0].text;
  assert.match(out, /Soups \(1 recipes\)/);
});

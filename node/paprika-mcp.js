#!/usr/bin/env node
// Paprika 3 MCP server - single file, no dependencies. Node 18+.
//
// Node port of the hardened Go server in this repo, for machines where
// Windows Smart App Control blocks unsigned executables (node.exe is signed).
//
// Tools: search_paprika_recipes, get_paprika_recipe, create_paprika_recipe,
// update_paprika_recipe, list_paprika_categories, create_paprika_category.
// There is deliberately no delete tool for recipes or categories.
//
// Credentials come from PAPRIKA_USERNAME and PAPRIKA_PASSWORD only.
// The only host contacted is paprikaapp.com. Logs go to stderr.
'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const readline = require('node:readline');

const VERSION = '0.4.0-node';
const API = 'https://paprikaapp.com/api';
const CACHE_TTL_MS = 2 * 60 * 1000;
const PROTOCOL_VERSION = '2024-11-05';

function log(...args) {
  process.stderr.write(`[paprika-mcp] ${args.join(' ')}\n`);
}

// Fields a new recipe gets, matching what the Paprika apps send.
function blankRecipe() {
  return {
    uid: '', name: '', ingredients: '', directions: '', description: '', notes: '',
    nutritional_info: '', servings: '', difficulty: '', prep_time: '', cook_time: '',
    total_time: '', source: '', source_url: '', image_url: '', photo: '', photo_hash: '',
    photo_large: null, scale: null, hash: '', categories: [], rating: 0, in_trash: false,
    is_pinned: false, on_favorites: false, on_grocery_list: false, created: '', photo_url: '',
  };
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// sha256 over the recipe with sorted keys, excluding the hash field itself.
function recipeHash(recipe) {
  const sorted = {};
  for (const k of Object.keys(recipe).sort()) {
    if (k !== 'hash') sorted[k] = recipe[k];
  }
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

class PaprikaClient {
  constructor({ username, password, fetchImpl = globalThis.fetch }) {
    this.username = username;
    this.password = password;
    this.fetch = fetchImpl;
    this.token = null;
  }

  async login() {
    const body = new URLSearchParams({ email: this.username, password: this.password });
    const res = await this.fetch(`${API}/v1/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !json.result || !json.result.token) throw new Error('login failed: no token returned');
    this.token = json.result.token;
  }

  async request(method, path, init = {}, retried = false) {
    if (!this.token) await this.login();
    const res = await this.fetch(`${API}${path}`, {
      method,
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${this.token}`, 'User-Agent': `paprika-3-mcp/${VERSION}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.request(method, path, init, true);
    }
    if (!res.ok) throw new Error(`${method} ${path} failed: HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.error) throw new Error(`${method} ${path} failed: ${json.error.message || JSON.stringify(json.error)}`);
    return json ? json.result : null;
  }

  listRecipes() {
    return this.request('GET', '/v2/sync/recipes/');
  }

  getRecipe(uid) {
    return this.request('GET', `/v2/sync/recipe/${encodeURIComponent(uid)}/`);
  }

  listCategories() {
    return this.request('GET', '/v2/sync/categories/');
  }

  // Uploads category objects (new or changed). Paprika expects a gzipped
  // JSON array in a multipart "data" field, like recipes.
  async saveCategories(categories) {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(categories)));
    const form = new FormData();
    form.append('data', new Blob([gz]), 'data');
    await this.request('POST', '/v2/sync/categories/', { body: form });
    try {
      await this.request('POST', '/v2/sync/notify/');
    } catch (err) {
      log('notify failed (non-fatal):', err.message);
    }
  }

  // Saves the full recipe object as given. Callers must start from the
  // current server copy so nothing is lost.
  async saveRecipe(recipe) {
    const r = { ...recipe };
    r.uid = (r.uid || crypto.randomUUID()).toUpperCase();
    if (!r.created) r.created = nowStamp();
    r.hash = recipeHash(r);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(r)));
    const form = new FormData();
    form.append('data', new Blob([gz]), 'data');
    await this.request('POST', `/v2/sync/recipe/${r.uid}/`, { body: form });
    try {
      await this.request('POST', '/v2/sync/notify/');
    } catch (err) {
      log('notify failed (non-fatal):', err.message);
    }
    return r;
  }
}

const TOOLS = [
  {
    name: 'search_paprika_recipes',
    description: 'Search Paprika recipes by text across name, ingredients, directions, notes, description and source. An empty query lists every recipe. Returns uid, name, rating and source for each match; use get_paprika_recipe for the full recipe.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for. All words must match (case-insensitive). Empty lists all recipes.' },
        category: { type: 'string', description: 'Only recipes in this category (exact name, case-insensitive). Use "(none)" for uncategorized recipes.' },
        limit: { type: 'number', description: 'Maximum results to return (default 25).' },
      },
    },
  },
  {
    name: 'get_paprika_recipe',
    description: 'Get one Paprika recipe in full by uid: ingredients, directions, notes, rating and source.',
    inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'Recipe uid from search_paprika_recipes.' } }, required: ['uid'] },
  },
  {
    name: 'create_paprika_recipe',
    description: 'Create a new recipe in Paprika. Ingredients and directions are one item per line.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, ingredients: { type: 'string', description: 'One per line.' },
        directions: { type: 'string', description: 'One step per line.' }, description: { type: 'string' },
        notes: { type: 'string' }, servings: { type: 'string' }, prep_time: { type: 'string' },
        cook_time: { type: 'string' }, total_time: { type: 'string' }, difficulty: { type: 'string' },
        source: { type: 'string' }, source_url: { type: 'string' },
      },
      required: ['name', 'ingredients', 'directions'],
    },
  },
  {
    name: 'update_paprika_recipe',
    description: 'Update an existing Paprika recipe. Only the fields you pass change; everything else (photo, rating, categories, source, any other field) is kept. Use append_notes to add to notes without replacing them. Cannot remove recipes.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' }, name: { type: 'string' },
        ingredients: { type: 'string', description: 'Replacement ingredients, one per line.' },
        directions: { type: 'string', description: 'Replacement directions, one step per line.' },
        description: { type: 'string' }, notes: { type: 'string', description: 'Replaces all existing notes.' },
        append_notes: { type: 'string', description: 'Added to the end of the existing notes.' },
        servings: { type: 'string' }, prep_time: { type: 'string' }, cook_time: { type: 'string' },
        total_time: { type: 'string' }, difficulty: { type: 'string' }, source: { type: 'string' },
        source_url: { type: 'string' }, rating: { type: 'number', description: '0-5' },
        set_categories: { type: 'array', items: { type: 'string' }, description: 'Category names that REPLACE the recipe\'s categories. Names must already exist (see list_paprika_categories).' },
        add_categories: { type: 'array', items: { type: 'string' }, description: 'Category names to add, keeping existing ones.' },
        remove_categories: { type: 'array', items: { type: 'string' }, description: 'Category names to take off this recipe (the category itself is kept).' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'list_paprika_categories',
    description: 'List all Paprika categories with how many recipes use each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_paprika_category',
    description: 'Create a new top-level Paprika category. Refuses if a category with that name already exists.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

const UPDATABLE_STRINGS = ['name', 'ingredients', 'directions', 'description', 'notes', 'servings',
  'prep_time', 'cook_time', 'total_time', 'difficulty', 'source', 'source_url'];

function matches(recipe, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [recipe.name, recipe.ingredients, recipe.directions, recipe.notes, recipe.description, recipe.source, recipe.source_url]
    .map((v) => v || '').join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

function formatRecipe(r) {
  const out = [`uid: ${r.uid}`, `rating: ${r.rating || 0}`];
  if (r.source) out.push(`source: ${r.source}`);
  if (r.source_url) out.push(`source_url: ${r.source_url}`);
  out.push('', `# ${r.name}`, '');
  if (r.description) out.push(r.description, '');
  const details = [['Servings', r.servings], ['Prep', r.prep_time], ['Cook', r.cook_time], ['Total', r.total_time], ['Difficulty', r.difficulty]]
    .filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  if (details.length) out.push('## Details', ...details, '');
  if (r.ingredients) out.push('## Ingredients', ...r.ingredients.trim().split('\n').filter(Boolean).map((l) => `- ${l}`), '');
  if (r.directions) out.push('## Directions', ...r.directions.trim().split('\n').filter(Boolean).map((l, i) => `${i + 1}. ${l}`), '');
  if (r.notes) out.push('## Notes', r.notes, '');
  return out.join('\n');
}

// Overlays only the fields present in args. Returns the changed field names.
function applyUpdate(recipe, args) {
  const changed = [];
  for (const key of UPDATABLE_STRINGS) {
    if (typeof args[key] === 'string') {
      recipe[key] = args[key];
      changed.push(key);
    }
  }
  if (typeof args.append_notes === 'string' && args.append_notes) {
    const cur = recipe.notes || '';
    recipe.notes = cur.trim() ? `${cur.replace(/\n+$/, '')}\n\n${args.append_notes}` : args.append_notes;
    changed.push('append_notes');
  }
  if (typeof args.rating === 'number' && Number.isFinite(args.rating)) {
    recipe.rating = Math.max(0, Math.min(5, Math.round(args.rating)));
    changed.push('rating');
  }
  return changed;
}

class RecipeServer {
  constructor(client) {
    this.client = client;
    this.cache = new Map(); // uid -> { hash, trashed, recipe }
    this.refreshedAt = 0;
    this.categories = new Map(); // uid -> category object
    this.categoriesAt = 0;
  }

  async refreshCategories(force = false) {
    if (!force && Date.now() - this.categoriesAt < CACHE_TTL_MS) return;
    const list = (await this.client.listCategories()) || [];
    this.categories = new Map(list.map((c) => [c.uid, c]));
    this.categoriesAt = Date.now();
  }

  categoryNames(recipe) {
    return (recipe.categories || []).map((u) => (this.categories.get(u) || { name: `(unknown ${u})` }).name);
  }

  // Resolves names to uids. Throws listing any names that don't exist.
  resolveCategories(names) {
    const byName = new Map([...this.categories.values()].map((c) => [c.name.toLowerCase(), c.uid]));
    const missing = names.filter((n) => !byName.has(String(n).trim().toLowerCase()));
    if (missing.length) throw new Error(`unknown categories: ${missing.join(', ')}. Create them first with create_paprika_category.`);
    return names.map((n) => byName.get(String(n).trim().toLowerCase()));
  }

  async listCategories() {
    await this.refreshCategories(true);
    await this.refresh();
    const counts = new Map();
    for (const c of this.cache.values()) {
      if (c.trashed) continue;
      for (const u of c.recipe.categories || []) counts.set(u, (counts.get(u) || 0) + 1);
    }
    const cats = [...this.categories.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!cats.length) return 'No categories yet.';
    return cats.map((c) => `- ${c.name} (${counts.get(c.uid) || 0} recipes)${c.parent_uid ? ' [sub-category]' : ''}`).join('\n');
  }

  async createCategory(args) {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('name is required');
    await this.refreshCategories(true);
    if ([...this.categories.values()].some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`a category named "${name}" already exists`);
    }
    const maxOrder = Math.max(-1, ...[...this.categories.values()].map((c) => Number(c.order_flag) || 0));
    const cat = { uid: crypto.randomUUID().toUpperCase(), name, order_flag: maxOrder + 1, parent_uid: null };
    await this.client.saveCategories([cat]);
    await this.refreshCategories(true);
    if (![...this.categories.values()].some((c) => c.uid === cat.uid)) {
      throw new Error('Paprika accepted the request but the category did not appear. Not retrying.');
    }
    log('created category', name);
    return `Created category "${name}".`;
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.refreshedAt < CACHE_TTL_MS) return;
    const list = (await this.client.listRecipes()) || [];
    const seen = new Set();
    for (const { uid, hash } of list) {
      seen.add(uid);
      const cached = this.cache.get(uid);
      if (cached && cached.hash === hash) continue;
      try {
        const r = await this.client.getRecipe(uid);
        this.cache.set(uid, r.in_trash ? { hash, trashed: true } : { hash, trashed: false, recipe: r });
      } catch (err) {
        log('failed to fetch recipe', uid, err.message);
      }
    }
    for (const uid of this.cache.keys()) if (!seen.has(uid)) this.cache.delete(uid);
    this.refreshedAt = Date.now();
  }

  async search(args) {
    await this.refresh();
    const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 25;
    const live = [...this.cache.values()].filter((c) => !c.trashed).map((c) => c.recipe);
    await this.refreshCategories();
    let pool = live;
    if (typeof args.category === 'string' && args.category.trim()) {
      const want = args.category.trim().toLowerCase();
      if (want === '(none)') {
        pool = live.filter((r) => !(r.categories || []).length);
      } else {
        const cat = [...this.categories.values()].find((c) => c.name.toLowerCase() === want);
        if (!cat) throw new Error(`no category named "${args.category}". Use list_paprika_categories.`);
        pool = live.filter((r) => (r.categories || []).includes(cat.uid));
      }
    }
    let hits = pool.filter((r) => matches(r, args.query)).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    let head = `${hits.length} of ${live.length} recipes match`;
    if (hits.length > limit) {
      head += ` (showing first ${limit})`;
      hits = hits.slice(0, limit);
    }
    const lines = hits.map((r) => {
      let line = `- ${r.name} | uid: ${r.uid} | rating: ${r.rating || 0}`;
      const cats = this.categoryNames(r);
      if (cats.length) line += ` | categories: ${cats.join(', ')}`;
      if (r.source) line += ` | source: ${r.source}`;
      if (r.source_url) line += ` | ${r.source_url}`;
      return line;
    });
    return `${head}.\n\n${lines.join('\n')}`;
  }

  async get(args) {
    if (!args.uid) throw new Error('uid is required');
    const r = await this.client.getRecipe(args.uid);
    if (r.in_trash) throw new Error('that recipe is in the Paprika trash');
    await this.refreshCategories();
    const cats = this.categoryNames(r);
    return (cats.length ? `categories: ${cats.join(', ')}\n` : 'categories: (none)\n') + formatRecipe(r);
  }

  async create(args) {
    if (!args.name || !args.ingredients || !args.directions) throw new Error('name, ingredients and directions are required');
    const r = blankRecipe();
    for (const key of UPDATABLE_STRINGS) if (typeof args[key] === 'string') r[key] = args[key];
    const saved = await this.client.saveRecipe(r);
    this.refreshedAt = 0;
    log('created recipe', saved.uid);
    return `Created.\n\n${formatRecipe(saved)}`;
  }

  async update(args) {
    if (!args.uid) throw new Error('uid is required');
    // Always start from the current server copy so untouched fields survive.
    const current = await this.client.getRecipe(args.uid);
    if (current.in_trash) throw new Error('that recipe is in the Paprika trash; not updating it');
    const changed = applyUpdate(current, args);
    const lists = ['set_categories', 'add_categories', 'remove_categories'].filter((k) => Array.isArray(args[k]));
    if (lists.length) {
      await this.refreshCategories();
      let cats = [...(current.categories || [])];
      if (Array.isArray(args.set_categories)) cats = this.resolveCategories(args.set_categories);
      if (Array.isArray(args.add_categories)) {
        for (const u of this.resolveCategories(args.add_categories)) if (!cats.includes(u)) cats.push(u);
      }
      if (Array.isArray(args.remove_categories)) {
        const drop = new Set(this.resolveCategories(args.remove_categories));
        cats = cats.filter((u) => !drop.has(u));
      }
      current.categories = cats;
      changed.push(...lists);
    }
    if (!changed.length) throw new Error('no fields to update were given');
    if (!current.name) throw new Error('a recipe name cannot be empty');
    const saved = await this.client.saveRecipe(current);
    this.refreshedAt = 0;
    log('updated recipe', saved.uid, changed.join(','));
    const catLine = `categories: ${this.categoryNames(saved).join(', ') || '(none)'}`;
    return `Updated ${changed.join(', ')}.\n${catLine}\n\n${formatRecipe(saved)}`;
  }

  async callTool(name, args = {}) {
    switch (name) {
      case 'search_paprika_recipes': return this.search(args);
      case 'get_paprika_recipe': return this.get(args);
      case 'create_paprika_recipe': return this.create(args);
      case 'update_paprika_recipe': return this.update(args);
      case 'list_paprika_categories': return this.listCategories();
      case 'create_paprika_category': return this.createCategory(args);
      default: throw new Error(`unknown tool: ${name}`);
    }
  }

  // Handles one JSON-RPC message. Returns a response object, or null for notifications.
  async handle(msg) {
    const { id, method, params } = msg || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined || id === null) return null; // notification
    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'paprika-3-mcp', version: VERSION },
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          try {
            const text = await this.callTool(params && params.name, (params && params.arguments) || {});
            return reply({ content: [{ type: 'text', text }] });
          } catch (err) {
            return reply({ content: [{ type: 'text', text: err.message }], isError: true });
          }
        }
        default:
          return fail(-32601, `method not found: ${method}`);
      }
    } catch (err) {
      return fail(-32603, err.message);
    }
  }
}

function main() {
  const username = process.env.PAPRIKA_USERNAME;
  const password = process.env.PAPRIKA_PASSWORD;
  if (!username || !password) {
    log('PAPRIKA_USERNAME and PAPRIKA_PASSWORD environment variables are required');
    process.exit(1);
  }
  const server = new RecipeServer(new PaprikaClient({ username, password }));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const res = await server.handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
  log('started', VERSION);
}

if (require.main === module) main();

module.exports = { PaprikaClient, RecipeServer, applyUpdate, matches, recipeHash, TOOLS };

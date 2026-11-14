#!/usr/bin/env node
// Paprika 3 MCP server - single file, no dependencies. Node 18+.
//
// Node port of the hardened Go server in this repo, for machines where
// Windows Smart App Control blocks unsigned executables (node.exe is signed).
//
// Tools: search_paprika_recipes, get_paprika_recipe, create_paprika_recipe,
// update_paprika_recipe. There is deliberately no delete tool.
//
// Credentials come from PAPRIKA_USERNAME and PAPRIKA_PASSWORD only.
// The only host contacted is paprikaapp.com. Logs go to stderr.
'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const readline = require('node:readline');

const VERSION = '0.3.0-node';
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
      },
      required: ['uid'],
    },
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
    let hits = live.filter((r) => matches(r, args.query)).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    let head = `${hits.length} of ${live.length} recipes match`;
    if (hits.length > limit) {
      head += ` (showing first ${limit})`;
      hits = hits.slice(0, limit);
    }
    const lines = hits.map((r) => {
      let line = `- ${r.name} | uid: ${r.uid} | rating: ${r.rating || 0}`;
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
    return formatRecipe(r);
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
    if (!changed.length) throw new Error('no fields to update were given');
    if (!current.name) throw new Error('a recipe name cannot be empty');
    const saved = await this.client.saveRecipe(current);
    this.refreshedAt = 0;
    log('updated recipe', saved.uid, changed.join(','));
    return `Updated ${changed.join(', ')}.\n\n${formatRecipe(saved)}`;
  }

  async callTool(name, args = {}) {
    switch (name) {
      case 'search_paprika_recipes': return this.search(args);
      case 'get_paprika_recipe': return this.get(args);
      case 'create_paprika_recipe': return this.create(args);
      case 'update_paprika_recipe': return this.update(args);
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

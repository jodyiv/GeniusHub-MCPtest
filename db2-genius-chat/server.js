import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ALL_PROFILES, isFleetQuestion, detectTopics, backupWindowDays, runFleet, FLEET_HELP } from './fleet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const cfg = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  ghHost: env.GH_HOST || 'db2server',
  ghPort: env.GH_PORT || '11100',
  ghProtocol: env.GH_PROTOCOL || 'http',
  mcpUrl: env.MCP_URL || 'https://db2server:8000/mcp',
  insecureTls: (env.INSECURE_TLS ?? 'true') !== 'false',
  llmBaseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  llmApiKey: env.LLM_API_KEY || '',
  llmModel: env.LLM_MODEL || 'gpt-4o',
  idleMs: 30 * 60 * 1000,
  maxToolRounds: 8,
  maxToolChars: 12000,
  maxHistory: 40,
};

// Only the MCP endpoint is allowed to use a self-signed certificate; no process-wide TLS override.
const mcpDispatcher = new Agent({ connect: { rejectUnauthorized: !cfg.insecureTls } });
const mcpFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: mcpDispatcher });

// Tools the LLM must not call: session handling is owned by this app.
const HIDDEN_TOOLS = new Set([
  'authenticate', 'connect_to_profile', 'logout', 'get_session_info',
  'search_tools', 'search_tools_regex',
]);

const SYSTEM_PROMPT = (profile) => `You are a Db2 DBA assistant connected to IBM Db2 Genius Hub through MCP tools.
Active database profile: ${profile || 'none'}.
- Always use the tools to get real data; never invent metrics, table names or values.
- Time-range arguments are natural language (e.g. "24 hours ago"). Only fill optional arguments when the user asks for them.
- For ad-hoc SQL use execute_safe_sql (read-only). If a table name is unknown, look it up first with fetch_tables.
- Answer concisely in Markdown. Use tables for tabular data and call out anything abnormal (high utilisation, blocking, stale stats) with a recommended next step.
- Call a tool with as few arguments as possible; leave optional arguments out unless the user asked for them. Never pass the text "None" or "False".
- Never write SQL or fabricate output tables yourself. If a tool fails, say what failed and stop; do not guess results.`;

// ---------------------------------------------------------------- guide / catalog helpers
/** Genius Hub tokens are JWTs; the payload carries the expiry (ms in `expiredTime`, s in `exp`). */
function jwtExpiry(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return Number(p.expiredTime) || (Number(p.exp) ? Number(p.exp) * 1000 : null);
  } catch { return null; }
}
const maskToken = (t) => (t.length > 24 ? `${t.slice(0, 10)}…${t.slice(-6)}` : '…');

const TOOL_CATEGORIES = [
  ['Session & connection', ['authenticate', 'connect_to_profile', 'get_session_info', 'logout', 'get_server_status']],
  ['Performance monitoring', ['get_cpu_summary', 'get_memory_summary', 'analyze_io_usage', 'get_query_throughput', 'get_response_time', 'get_timespent', 'get_bufferpool_statistics', 'get_top_sql', 'analyze_disk_spilling']],
  ['Locking & concurrency', ['get_locks', 'analyze_lock_waits', 'get_blocking_transaction_analysis']],
  ['Storage & space', ['get_tablespace', 'get_tablespace_io']],
  ['Metadata & history', ['fetch_tables', 'fetch_db_history', 'get_db_upgrade_history', 'fetch_dic_db_profiles', 'get_instance_info', 'get_hadr_status', 'get_whats_changed', 'list_models']],
  ['Health & workload', ['perform_database_health_check', 'wlm_get_query_queue_state', 'wlm_queue_analyzer', 'get_autoconfigure_recommendations']],
  ['Query analysis & tuning', ['execute_safe_sql', 'get_explain_plan', 'tune_query', 'text_to_sql', 'similarity_search', 'perform_impact_analysis']],
  ['Tool discovery', ['search_tools', 'search_tools_regex']],
];

// ---------------------------------------------------------------- sessions
/** @type {Map<string, {id:string,user:string,client:Client,transport:any,tools:any[],profile:string|null,messages:any[],last:number,busy:boolean}>} */
const sessions = new Map();

async function closeSession(s) {
  sessions.delete(s.id);
  try { await s.client.callTool({ name: 'logout', arguments: {} }); } catch { /* best effort */ }
  try { await s.client.close(); } catch { /* best effort */ }
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (!s.busy && now - s.last > cfg.idleMs) closeSession(s);
}, 60_000).unref();

/** Fetches a brand-new Genius Hub token. Called once per login (= per session). */
async function fetchGeniusHubToken(userid, password) {
  const res = await fetch(`${cfg.ghProtocol}://${cfg.ghHost}:${cfg.ghPort}/dbapi/v4/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid, password }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) throw httpError(401, 'Invalid Genius Hub user id or password.');
  if (!res.ok) throw httpError(502, `Genius Hub returned HTTP ${res.status} when requesting a token.`);
  const body = await res.json();
  if (!body.token) throw httpError(502, 'Genius Hub did not return a token.');
  return body.token;
}

async function openMcp(token) {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
    fetch: mcpFetch,
    requestInit: {
      headers: {
        'X-Genius-Hub-Hostname': cfg.ghHost,
        'X-Genius-Hub-Port': String(cfg.ghPort),
        'X-Genius-Hub-Protocol': cfg.ghProtocol,
        'X-Genius-Hub-Token': token,
      },
    },
  });
  const client = new Client({ name: 'db2-genius-chat', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** True when the Genius Hub MCP server no longer knows our MCP session (restart, expiry, eviction). */
const isStaleSession = (e) => /session not found|\b404\b|\b-32600\b/i.test(String(e?.message || e));

/**
 * Wraps session.client so that a lost MCP session is transparently re-opened with the same
 * Genius Hub token, the current database is re-selected, and the call is retried once.
 * Everything that talks to MCP on behalf of a user goes through `session.mcp`.
 */
function attachResilientMcp(session) {
  session.mcp = {
    async callTool(req) {
      try {
        const res = await session.client.callTool(req);
        trackProfile(session, req, res);
        return res;
      } catch (e) {
        if (!isStaleSession(e)) throw e;
        await reopen(session);
        const res = await session.client.callTool(req); // second failure propagates with its real message
        trackProfile(session, req, res);
        return res;
      }
    },
  };
}

function trackProfile(session, req, res) {
  if (req.name !== 'connect_to_profile' || res?.isError) return;
  const status = res?.structuredContent?.status;
  if (status && status !== 'authenticated') return;
  session.currentProfile = req.arguments?.profile_name || session.currentProfile;
}

let reopening = new WeakMap(); // session -> in-flight promise, so parallel calls reopen only once
async function reopen(session) {
  if (reopening.has(session)) return reopening.get(session);
  const job = (async () => {
    try { await session.client.close(); } catch { /* already dead */ }
    let mcp;
    try { mcp = await openMcp(session.token); } catch (e) {
      throw httpError(502, `Lost the Genius Hub MCP session and could not re-open it (${e.message}). Sign in again.`);
    }
    session.client = mcp.client;
    session.transport = mcp.transport;
    if (session.currentProfile) {
      await mcp.client.callTool({ name: 'connect_to_profile', arguments: { profile_name: session.currentProfile } });
    }
    session.reconnects = (session.reconnects || 0) + 1;
    console.log(`[mcp] re-opened session for ${session.user} (profile ${session.currentProfile || 'none'}, reconnect #${session.reconnects})`);
  })().finally(() => reopening.delete(session));
  reopening.set(session, job);
  return job;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Pull the first JSON object out of an MCP tool result. */
function toolJson(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function listProfiles(client) {
  const res = await client.callTool({ name: 'fetch_dic_db_profiles', arguments: { params: { limit: 200 } } });
  const data = toolJson(res);
  return (data.data || []).map((p) => p.profile_name).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- LLM loop
// Small local models (e.g. Granite on CPU) cannot cope with 30+ verbose tool schemas, so we
// (1) strip the schemas down to what the model needs and (2) offer only tools relevant to the question.
const TOOL_ROUTES = [
  ['get_cpu_summary', /\bcpu|processor/i],
  ['get_memory_summary', /\bmemory|\bram\b/i],
  ['analyze_io_usage', /\bi\/?o\b|disk|throughput.*io|io.*(usage|trend)/i],
  ['get_query_throughput', /throughput/i],
  ['get_response_time', /response time|latency/i],
  ['get_timespent', /time spent|where.*time/i],
  ['get_bufferpool_statistics', /buffer ?pool|hit ratio/i],
  ['get_top_sql', /top (\d+ )?(sql|quer|statement)|slow|expensive|longest|heaviest/i],
  ['get_locks', /\block/i],
  ['analyze_lock_waits', /lock wait|blocked|blocking|block(er)?s?\b|who.*holding|deadlock/i],
  ['get_blocking_transaction_analysis', /blocking|log pressure|transaction/i],
  ['get_tablespace', /table ?space|space|storage|full|capacity|disk usage|how big|size/i],
  ['get_tablespace_io', /table ?space.*(io|i\/o)/i],
  ['fetch_tables', /\btables?\b|row count|runstats|statistics|stats|largest|schema/i],
  ['fetch_db_history', /backup|restore|history/i],
  ['get_db_upgrade_history', /upgrade|version history/i],
  ['get_instance_info', /instance|version|fix ?pack|uptime|platform/i],
  ['get_hadr_status', /hadr|standby|replication/i],
  ['perform_database_health_check', /health|resilien|healthy/i],
  ['get_whats_changed', /what.*changed|recent change/i],
  ['wlm_get_query_queue_state', /queue|queued|wlm/i],
  ['wlm_queue_analyzer', /queue|queued|wlm/i],
  ['analyze_disk_spilling', /spill/i],
  ['tune_query', /\btune|tuning|optimi[sz]e (this )?query/i],
  ['get_explain_plan', /explain|access plan/i],
  ['perform_impact_analysis', /impact/i],
  ['get_autoconfigure_recommendations', /autoconfig|configuration recommend/i],
  ['text_to_sql', /generate (an )?sql|write (me )?(an )?sql|convert.*sql/i],
  ['similarity_search', /similar quer/i],
];
const DEFAULT_TOOLS = ['perform_database_health_check', 'get_tablespace', 'get_top_sql', 'fetch_tables'];
const MAX_TOOLS = 6;

function pickTools(tools, question) {
  const byName = new Map(tools.filter((t) => !HIDDEN_TOOLS.has(t.name)).map((t) => [t.name, t]));
  const names = [];
  for (const [name, re] of TOOL_ROUTES) if (re.test(question) && byName.has(name) && !names.includes(name)) names.push(name);
  if (/\bselect\b[\s\S]+\bfrom\b/i.test(question) && !/tune|explain/i.test(question)) names.unshift('execute_safe_sql');
  if (!names.length) names.push(...DEFAULT_TOOLS, 'execute_safe_sql');
  return names.slice(0, MAX_TOOLS).map((n) => byName.get(n)).filter(Boolean);
}

const firstSentence = (text = '', max = 160) => {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const out = m ? m[1] : t;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};

// Column-toggle / member options: noise for small models, and the server defaults are fine.
const NOISY_PARAM = /^(cols?_|args_member$|member$|include_raw_fields$)/;

/** Reduce a JSON schema to type / enum / short description. Drops defaults, null-unions and noise. */
function compactSchema(sch, depth = 0) {
  if (!sch || typeof sch !== 'object') return { type: 'string' };
  if (Array.isArray(sch.anyOf)) {
    const real = sch.anyOf.filter((x) => x && x.type !== 'null');
    const picked = real[0] ? compactSchema(real[0], depth) : { type: 'string' };
    if (sch.description && !picked.description) picked.description = firstSentence(sch.description, 120);
    return picked;
  }
  const out = {};
  if (sch.type) out.type = sch.type;
  if (sch.enum) out.enum = sch.enum.slice(0, 12);
  if (sch.description && depth > 0) out.description = firstSentence(sch.description, 120);
  if (sch.items) out.items = compactSchema(sch.items, depth + 1);
  if (sch.properties) {
    out.type = 'object';
    out.properties = {};
    for (const [k, v] of Object.entries(sch.properties)) {
      if (NOISY_PARAM.test(k)) continue;
      out.properties[k] = compactSchema(v, depth + 1);
    }
    if (sch.required?.length) out.required = sch.required;
  }
  return out;
}

/** Every Genius Hub tool takes {params: {...}}. Expose the inner object to the model and re-wrap later. */
const wrapsParams = (t) => {
  const props = t.inputSchema?.properties;
  return !!props && Object.keys(props).length === 1 && !!props.params?.properties;
};
// Filled in by the server so the model does not have to write them.
const AUTO_FIELDS = { initial_message: 'Here is the data from {start_time} to {end_time}.' };

function mcpToolsToOpenAI(tools) {
  return tools.map((t) => {
    let schema = t.inputSchema?.type ? t.inputSchema : { type: 'object', properties: {} };
    if (wrapsParams(t)) schema = schema.properties.params;
    const c = compactSchema(schema);
    for (const k of Object.keys(AUTO_FIELDS)) {
      delete c.properties?.[k];
      if (c.required) c.required = c.required.filter((r) => r !== k);
    }
    if (c.required && !c.required.length) delete c.required;
    return {
      type: 'function',
      function: { name: t.name, description: firstSentence(t.description || t.name, 200), parameters: { type: 'object', properties: {}, ...c } },
    };
  });
}

async function callLlm(messages, tools) {
  if (!cfg.llmApiKey && cfg.llmBaseUrl.includes('openai.com')) {
    throw httpError(500, 'LLM_API_KEY is not configured on the server (see .env.example).');
  }
  const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.llmApiKey ? { Authorization: `Bearer ${cfg.llmApiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.llmModel, messages, temperature: 0.1, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
    signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS || 240000)),
  });
  if (!res.ok) throw httpError(502, `LLM request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const msg = body.choices?.[0]?.message;
  if (!msg) throw httpError(502, 'LLM returned no message.');
  return msg;
}

function truncate(text) {
  return text.length > cfg.maxToolChars
    ? `${text.slice(0, cfg.maxToolChars)}\n…[truncated ${text.length - cfg.maxToolChars} chars]`
    : text;
}

const NULLISH = new Set(['none', 'null', 'undefined', 'n/a', '']);

/** Small models send "None", "False", "5" as strings. Coerce to the schema type or drop. */
function coerceArg(value, schema = {}) {
  const pick = Array.isArray(schema.anyOf) ? schema.anyOf.find((x) => x?.type && x.type !== 'null') || {} : schema;
  const type = pick.type;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const v = value.trim();
    if (NULLISH.has(v.toLowerCase())) return undefined;
    if (type === 'integer' || type === 'number') { const n = Number(v); return Number.isFinite(n) ? (type === 'integer' ? Math.trunc(n) : n) : undefined; }
    if (type === 'boolean') return /^(true|yes|1)$/i.test(v) ? true : undefined; // false == default
    if (type === 'array') return [v];
    return v;
  }
  if (type === 'boolean') return value === true ? true : undefined;
  if (type === 'array' && !Array.isArray(value)) return [value];
  return value;
}

const MAX_MODEL_ROWS = 15;
const MAX_UI_ROWS = 50;

const dropEmpty = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && v !== '' && !/note$/i.test(k)))
  : o);

/** What the model sees: just the facts, no recommendations/metadata boilerplate. */
function compactResult(raw, rows, failed) {
  if (failed) return `ERROR: ${raw.message || raw.error || raw.raw || 'tool failed'}`;
  if (rows && !rows.length) return `${raw.message || 'OK'}\nThe tool returned no rows. Say so plainly. Do not write SQL or invent data.`;
  if (!rows) {
    const { recommendations, response_type, has_data, ...facts } = raw; // eslint-disable-line no-unused-vars
    return truncate(`DATA (JSON): ${JSON.stringify(facts)}\nSummarize ONLY the values present above. Do not create tables or data points that are not in the JSON. Do not write SQL.`);
  }
  const shown = rows.slice(0, MAX_MODEL_ROWS).map(dropEmpty);
  const more = rows.length > shown.length ? ` (${rows.length - shown.length} more rows not shown)` : '';
  return truncate(`${raw.message || 'OK'}${more}\nDATA (JSON): ${JSON.stringify(shown)}\n` +
    'Summarize ONLY this data for the user. Do not write SQL. Do not invent values.');
}

/** Small models invent filter values. Keep a string filter only if the user actually typed it. */
const FILTER_KEY = /^(args_|f_|filter_)/;
function dropInventedFilters(args, question) {
  const q = question.toLowerCase();
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const vals = Array.isArray(v) ? v : [v];
    const isFilter = FILTER_KEY.test(k) && vals.every((x) => typeof x === 'string');
    if (isFilter && !vals.every((x) => q.includes(x.toLowerCase()))) continue;
    out[k] = v;
  }
  return out;
}

// "Which tablespaces are more than 80% full?" -- small models list everything and ignore the number,
// so a stated percentage threshold is applied here, in code, to tablespace results.
const PCT_RE = /\b(more than|over|above|greater than|exceed(?:s|ing)?|at least|less than|under|below|fewer than)\s+(\d{1,3}(?:\.\d+)?)\s*%/i;

function applyPercentFilter(rows, question) {
  if (!rows.length || !('tbsp_utilization_percent' in rows[0])) return null;
  const m = PCT_RE.exec(question);
  if (!m) return null;
  const limit = parseFloat(m[2]);
  const phrase = m[1].toLowerCase();
  const below = /less|under|below|fewer/.test(phrase);
  const inclusive = phrase === 'at least';
  const measurable = rows.filter((r) => r.utilization_applicable !== false && Number.isFinite(parseFloat(r.tbsp_utilization_percent)));
  const kept = measurable.filter((r) => {
    const v = parseFloat(r.tbsp_utilization_percent);
    if (below) return inclusive ? v <= limit : v < limit;
    return inclusive ? v >= limit : v > limit;
  });
  const skipped = rows.length - measurable.length;
  const note = `Filter applied: tablespaces ${phrase} ${limit}% used. ${kept.length} of ${measurable.length} measurable tablespaces match` +
    `${skipped ? ` (${skipped} system-managed/temporary tablespace(s) have no utilisation figure and were excluded)` : ''}.`;
  if (!kept.length) {
    return { rows: [], text: `${note}\nNo tablespace matches. Say so plainly, mention the threshold, and do not invent data or write SQL.` };
  }
  const shown = kept.slice(0, MAX_MODEL_ROWS).map(dropEmpty);
  return {
    rows: kept,
    text: `${note}\nDATA (JSON): ${JSON.stringify(shown)}\nAnswer as a Markdown table with columns: tbsp_name (REQUIRED, first column), tbsp_utilization_percent, tbsp_used_size, tbsp_free_size. Use ONLY this data. Do not write SQL.`,
  };
}

async function runTool(session, call, question = '') {
  let args = {};
  try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* bad JSON from model */ }
  const def = session.tools.find((t) => t.name === call.function.name);
  if (def && wrapsParams(def)) {
    const inner = args.params && typeof args.params === 'object' && Object.keys(args).length === 1 ? args.params : args;
    const props = def.inputSchema.properties.params.properties;
    const clean = {};
    for (const [k, v] of Object.entries(inner)) {
      if (!(k in props) || NOISY_PARAM.test(k)) continue;
      const c = coerceArg(v, props[k]);
      if (c !== undefined) clean[k] = c;
    }
    for (const [k, v] of Object.entries(AUTO_FIELDS)) if (k in props) clean[k] = v;
    args = { params: dropInventedFilters(clean, question) };
  } else if (def) {
    const props = def.inputSchema?.properties || {};
    const clean = {};
    for (const [k, v] of Object.entries(args)) { const c = coerceArg(v, props[k]); if (k in props && c !== undefined) clean[k] = c; }
    args = dropInventedFilters(clean, question);
  }
  try {
    const res = await session.mcp.callTool({ name: call.function.name, arguments: args });
    const raw = toolJson(res);
    let rows = Array.isArray(raw.data) ? raw.data : null;
    const failed = !!res.isError || raw.status === 'error';
    const filtered = !failed && rows ? applyPercentFilter(rows, question) : null;
    if (filtered) return { text: filtered.text, rows: filtered.rows, isError: false, args };
    return { text: compactResult(raw, rows, failed), rows, isError: failed, args };
  } catch (e) {
    return { text: `Tool call failed: ${e.message}`, isError: true, args };
  }
}

// ---------------------------------------------------------------- enterprise questions
async function answerFleet(s, question, send, shouldStop, allMode) {
  const { topics, generic } = detectTopics(question);
  if (!topics.size && !generic && allMode) {
    send('answer', { text: FLEET_HELP });
    return;
  }
  if (!topics.size) ['space', 'backup', 'resources', 'health'].forEach((t) => topics.add(t)); // overview
  const windowDays = backupWindowDays(question);

  const profiles = await listProfiles(s.mcp);
  if (!profiles.length) { send('answer', { text: 'Genius Hub has no database profiles to check.' }); return; }

  const previous = s.singleProfile; // the fleet run switches the MCP connection; restore it afterwards
  let result;
  try {
    result = await runFleet({ client: s.mcp, profiles, topics, windowDays, send, shouldStop });
  } finally {
    if (previous) {
      try { await s.mcp.callTool({ name: 'connect_to_profile', arguments: { profile_name: previous } }); } catch { /* user can re-select */ }
    }
  }
  if (!result) return; // client went away
  send('fleet', result);
  send('answer', { text: result.summary });
  s.messages.push({ role: 'user', content: question }, { role: 'assistant', content: result.summary });
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  next();
});

const nm = (p) => path.join(__dirname, 'node_modules', p);
app.get('/vendor/marked.js', (_q, r) => r.sendFile(nm('marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (_q, r) => r.sendFile(nm('dompurify/dist/purify.min.js')));
app.use(express.static(path.join(__dirname, 'public')));

function cookieSid(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  return m?.[1];
}

function requireSession(req, res, next) {
  const s = sessions.get(cookieSid(req));
  if (!s) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  s.last = Date.now();
  req.session = s;
  next();
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (res.headersSent) return res.end();
  res.status(e.status || 500).json({ error: e.message || 'Unexpected error' });
});

app.get('/api/config', (_req, res) => {
  res.json({
    ghHost: cfg.ghHost, ghPort: cfg.ghPort, ghProtocol: cfg.ghProtocol, mcpUrl: cfg.mcpUrl,
    insecureTls: cfg.insecureTls, model: cfg.llmModel, llmBaseUrl: cfg.llmBaseUrl,
    llmConfigured: !!cfg.llmApiKey || !cfg.llmBaseUrl.includes('openai.com'),
  });
});

// Live facts about the signed-in session, for the in-app guide. Never returns the full token.
app.get('/api/connection', requireSession, (req, res) => {
  const s = req.session;
  const known = new Set();
  const categories = TOOL_CATEGORIES.map(([name, names]) => ({
    name,
    tools: names.filter((n) => s.tools.some((t) => t.name === n)).map((n) => {
      known.add(n);
      const t = s.tools.find((x) => x.name === n);
      return { name: n, description: firstSentence(t.description, 220), exposed: !HIDDEN_TOOLS.has(n) };
    }),
  })).filter((c) => c.tools.length);
  const other = s.tools.filter((t) => !known.has(t.name))
    .map((t) => ({ name: t.name, description: firstSentence(t.description, 220), exposed: !HIDDEN_TOOLS.has(t.name) }));
  if (other.length) categories.push({ name: 'Other', tools: other });

  res.json({
    user: s.user, profile: s.profile,
    token: { masked: s.tokenMasked, issuedAt: s.tokenIssuedAt, expiresAt: s.tokenExp },
    mcpSessionId: s.transport?.sessionId || null,
    reconnects: s.reconnects || 0,
    idleTimeoutMinutes: cfg.idleMs / 60000,
    toolCount: s.tools.length,
    exposedCount: s.tools.filter((t) => !HIDDEN_TOOLS.has(t.name)).length,
    categories,
  });
});

app.get('/api/me', (req, res) => {
  const s = sessions.get(cookieSid(req));
  res.json(s ? { user: s.user, profile: s.profile } : { user: null });
});

// New login => brand-new Genius Hub token => brand-new MCP session.
app.post('/api/login', wrap(async (req, res) => {
  const { userid, password } = req.body || {};
  if (typeof userid !== 'string' || typeof password !== 'string' || !userid || !password) {
    throw httpError(400, 'User id and password are required.');
  }
  const old = sessions.get(cookieSid(req));
  if (old) await closeSession(old);

  const token = await fetchGeniusHubToken(userid, password);
  let mcp;
  try { mcp = await openMcp(token); } catch (e) {
    throw httpError(502, `Could not reach the Genius Hub MCP server at ${cfg.mcpUrl}: ${e.message}`);
  }
  const tools = (await mcp.client.listTools()).tools;
  const profiles = await listProfiles(mcp.client);

  const id = crypto.randomBytes(24).toString('hex');
  const session = {
    id, user: userid, client: mcp.client, transport: mcp.transport, tools,
    profile: null, messages: [], last: Date.now(), busy: false,
    token, currentProfile: null, reconnects: 0, // token never leaves the server
    tokenIssuedAt: Date.now(), tokenExp: jwtExpiry(token), tokenMasked: maskToken(token),
  };
  attachResilientMcp(session);
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Strict; Path=/`);
  res.json({ user: userid, profiles });
}));

app.get('/api/profiles', requireSession, wrap(async (req, res) => {
  res.json({ profiles: await listProfiles(req.session.mcp), active: req.session.profile });
}));

app.post('/api/profile', requireSession, wrap(async (req, res) => {
  const name = req.body?.profile;
  if (typeof name !== 'string' || !name) throw httpError(400, 'profile is required');
  const s = req.session;
  if (name === ALL_PROFILES) { // enterprise view: no single connection, the fleet runner connects per profile
    s.profile = ALL_PROFILES;
    s.singleProfile = null;
    s.messages = [];
    return res.json({ profile: ALL_PROFILES, database: null });
  }
  const result = await s.mcp.callTool({ name: 'connect_to_profile', arguments: { profile_name: name } });
  const data = toolJson(result);
  if (result.isError || data.status === 'error') {
    throw httpError(502, data.message || data.error || `Could not connect to profile ${name}.`);
  }
  s.profile = name;
  s.singleProfile = name;
  s.messages = []; // a new database means a new conversation
  res.json({ profile: name, database: data.database });
}));

app.post('/api/chat', requireSession, wrap(async (req, res) => {
  const s = req.session;
  const question = String(req.body?.message || '').trim();
  if (!question) throw httpError(400, 'message is required');
  const fleetIntent = s.profile === ALL_PROFILES || isFleetQuestion(question);
  if (!s.profile && !fleetIntent) throw httpError(400, 'Select a database profile first.');
  if (s.busy) throw httpError(409, 'Previous question is still running.');

  s.busy = true;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const aborted = new AbortController();
  res.on('close', () => aborted.abort());

  const allMode = s.profile === ALL_PROFILES;
  if (fleetIntent) {
    try {
      await answerFleet(s, question, send, () => aborted.signal.aborted, allMode);
    } catch (e) {
      send('error', { message: e.message });
    } finally {
      s.busy = false;
      send('done', {});
      res.end();
    }
    return;
  }

  const tools = mcpToolsToOpenAI(pickTools(s.tools, question));
  const turnStart = s.messages.length;
  s.messages.push({ role: 'user', content: question });

  try {
    for (let round = 0; round < cfg.maxToolRounds; round++) {
      if (aborted.signal.aborted) break;
      const afterTools = s.messages.at(-1)?.role === 'tool';
      const msg = await callLlm([{ role: 'system', content: SYSTEM_PROMPT(s.profile) }, ...s.messages], afterTools ? undefined : tools);
      s.messages.push(msg);

      if (!msg.tool_calls?.length) {
        send('answer', { text: msg.content || '(no answer)' });
        break;
      }
      let failure = null;
      for (const call of msg.tool_calls) {
        send('tool', { id: call.id, name: call.function.name, status: 'running' });
        const t0 = Date.now();
        const out = await runTool(s, call, question);
        send('tool', { id: call.id, name: call.function.name, status: out.isError ? 'error' : 'done', args: out.args, ms: Date.now() - t0, error: out.isError ? out.text.slice(0, 300) : undefined });
        if (out.rows?.length && typeof out.rows[0] === 'object') send('table', { name: call.function.name, rows: out.rows.slice(0, MAX_UI_ROWS).map(dropEmpty), total: out.rows.length });
        s.messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
        if (out.isError && !failure) failure = { name: call.function.name, text: out.text };
      }
      if (failure) { // never let the model "try a different approach" and invent data
        const reason = failure.text.replace(/^(Tool call failed|ERROR):\s*/i, '').slice(0, 400);
        const text = `The \`${failure.name}\` tool failed, so I can't answer this from live data.\n\n> ${reason}\n\nTry the question again; if it keeps failing, sign out and back in to start a fresh session.`;
        s.messages.push({ role: 'assistant', content: text });
        send('answer', { text });
        break;
      }
      if (round === cfg.maxToolRounds - 1) {
        send('answer', { text: 'I reached the tool-call limit for one question. Try asking something narrower.' });
      }
    }
  } catch (e) {
    s.messages.length = turnStart; // drop the partial turn so history stays valid
    send('error', { message: e.message });
  } finally {
    if (s.messages.length > cfg.maxHistory) {
      // Trim from the front, then drop any leading non-user messages (orphaned tool results).
      s.messages.splice(0, s.messages.length - cfg.maxHistory);
      while (s.messages.length && s.messages[0].role !== 'user') s.messages.shift();
    }
    s.busy = false;
    send('done', {});
    res.end();
  }
}));

app.post('/api/reset', requireSession, (req, res) => {
  req.session.messages = [];
  res.json({ ok: true });
});

app.post('/api/logout', wrap(async (req, res) => {
  const s = sessions.get(cookieSid(req));
  if (s) await closeSession(s);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Db2 Genius Chat listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  Genius Hub : ${cfg.ghProtocol}://${cfg.ghHost}:${cfg.ghPort}`);
  console.log(`  MCP server : ${cfg.mcpUrl}${cfg.insecureTls ? ' (TLS verification off)' : ''}`);
  console.log(`  LLM        : ${cfg.llmModel} @ ${cfg.llmBaseUrl}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await Promise.allSettled([...sessions.values()].map(closeSession));
    server.close(() => process.exit(0));
  });
}

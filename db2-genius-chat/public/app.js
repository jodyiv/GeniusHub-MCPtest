const $ = (id) => document.getElementById(id);

const ALL = '__all__';

const EXAMPLES = [
  { group: 'Enterprise – all databases', fleet: true, items: [
    'Show all the databases with space issues.',
    'Show me all the databases with resource issues.',
    'Show me the databases that have not backed up this week.',
    'Which databases are unhealthy?',
    'Give me an overview of all my databases.',
  ] },
  { group: 'Performance', items: [
    'Show me CPU utilisation trends for the last 24 hours.',
    'What are the top 10 SQL statements by total execution time?',
    'Show me buffer pool hit ratios.',
    'Show memory usage over the last 12 hours.',
  ] },
  { group: 'Locking & concurrency', items: [
    'Which queries are currently blocked and by whom?',
    'Show current lock waits and the holding applications.',
    'Which transactions are putting the most pressure on the log?',
  ] },
  { group: 'Space & storage', items: [
    'Show me the space utilization for this database.',
    'Which tablespaces are more than 80% full?',
    'List the 10 largest tables by row count.',
  ] },
  { group: 'Health & maintenance', items: [
    'Run a health check on this database.',
    'When was the last full backup?',
    'Which tables have never had RUNSTATS collected?',
    'What changed in my database recently?',
  ] },
  { group: 'Configuration & instance', items: [
    'What Db2 version and fix pack is this instance running?',
    'Show the HADR status.',
  ] },
  { group: 'Query tuning & SQL', items: [
    'Tune this query: SELECT * FROM employee WHERE salary > 50000',
    'Explain the access plan for: SELECT * FROM employee WHERE workdept = \'A00\'',
    'SELECT COUNT(*) FROM syscat.tables WHERE tabschema = \'DB2INST1\'',
  ] },
];

const state = { profile: null, busy: false };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin('Your session expired. Please sign in again.'); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- views ---------------- */
function showLogin(message) {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('password').value = '';
  const err = $('login-error');
  err.hidden = !message;
  err.textContent = message || '';
}

function showApp(user, profiles) {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('whoami').textContent = user;
  renderProfiles(profiles);
  resetChat();
  setProfile(null);
}

function renderProfiles(profiles, active) {
  const sel = $('profile-select');
  sel.replaceChildren(new Option(profiles.length ? 'Select a profile…' : 'No profiles found', ''));
  if (profiles.length) {
    const g = document.createElement('optgroup'); g.label = 'Enterprise';
    g.append(new Option(`All databases (${profiles.length})`, ALL));
    const g2 = document.createElement('optgroup'); g2.label = 'Single database';
    for (const p of profiles) g2.append(new Option(p, p));
    sel.append(g, g2);
  }
  sel.value = active || '';
}

const isAll = () => state.profile === ALL;
const profileLabel = (n) => (n === ALL ? 'All databases' : n);

function setProfile(name) {
  state.profile = name;
  const pill = $('status');
  pill.className = `pill ${name ? 'on' : 'off'}`;
  pill.textContent = !name ? 'No profile' : isAll() ? 'Enterprise view' : `Connected: ${name}`;
  updateInputs();
}

function updateInputs() {
  const ready = !!state.profile && !state.busy;
  $('input').disabled = !ready;
  $('send').disabled = !ready;
  $('input').placeholder = !state.profile
    ? 'Select a profile to start asking questions'
    : isAll() ? 'Ask about all databases, e.g. which have space issues?' : `Ask about ${state.profile}…`;
  document.querySelectorAll('.ex').forEach((b) => {
    // Enterprise examples work without a selected profile; single-database ones do not.
    const fleetEx = b.dataset.fleet === '1';
    b.disabled = state.busy || (!state.profile && !fleetEx);
  });
  $('welcome-hint').textContent = isAll()
    ? 'Enterprise view: each question is checked against every database. Try an example on the left.'
    : state.profile
      ? 'Pick an example on the left or type your own question.'
      : 'Choose a database profile above, or try an enterprise example on the left.';
}

function renderExamples() {
  const root = $('examples');
  root.replaceChildren();
  for (const g of EXAMPLES) {
    const div = document.createElement('div');
    div.className = g.fleet ? 'ex-group fleet' : 'ex-group';
    const h = document.createElement('h3');
    h.textContent = g.group;
    div.append(h);
    for (const q of g.items) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ex'; b.textContent = q; b.disabled = true;
      if (g.fleet) b.dataset.fleet = '1';
      b.addEventListener('click', () => ask(q));
      div.append(b);
    }
    root.append(div);
  }
}

/* ---------------- chat ---------------- */
function resetChat() {
  const box = $('messages');
  [...box.children].forEach((c) => { if (c.id !== 'welcome') c.remove(); });
  $('welcome').hidden = false;
}

function addMsg(kind, content, markdown) {
  $('welcome').hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (markdown) el.innerHTML = DOMPurify.sanitize(marked.parse(content, { gfm: true }));
  else el.textContent = content;
  $('messages').append(el);
  scrollDown();
  return el;
}

function addTable({ name, rows, total }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12);
  const det = document.createElement('details');
  det.className = 'msg data'; det.open = rows.length <= 12;
  const sum = document.createElement('summary');
  sum.textContent = `${name} \u2013 ${total} row${total === 1 ? '' : 's'}${total > rows.length ? ` (showing ${rows.length})` : ''}`;
  const wrap = document.createElement('div'); wrap.className = 'tbl';
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const c of cols) { const th = document.createElement('th'); th.textContent = c; head.append(th); }
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of cols) { const v = r[c]; tr.insertCell().textContent = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
  }
  wrap.append(t); det.append(sum, wrap);
  $('welcome').hidden = true;
  $('messages').insertBefore(det, document.querySelector('.thinking'));
}

const SEV_LABEL = { crit: 'Critical', warn: 'Warning', ok: 'OK', na: 'No data' };

function addFleet(f) {
  const wrap = document.createElement('div');
  wrap.className = 'msg fleet';

  const chips = document.createElement('div');
  chips.className = 'fleet-counts';
  for (const k of ['crit', 'warn', 'ok', 'na']) {
    if (!f.counts[k]) continue;
    const c = document.createElement('span'); c.className = `sev ${k}`; c.textContent = `${f.counts[k]} ${SEV_LABEL[k]}`;
    chips.append(c);
  }
  const total = document.createElement('span'); total.className = 'fleet-total'; total.textContent = `${f.counts.total} databases checked`;
  chips.append(total);

  const scroller = document.createElement('div'); scroller.className = 'tbl';
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const h of ['Database', 'Status', ...f.columns.map((c) => c.label)]) {
    const th = document.createElement('th'); th.textContent = h; head.append(th);
  }
  const body = t.createTBody();
  for (const r of f.rows) {
    const tr = body.insertRow();
    const name = tr.insertCell();
    const strong = document.createElement('strong'); strong.textContent = r.profile; name.append(strong);
    if (r.database) { const sub = document.createElement('div'); sub.className = 'muted small'; sub.textContent = `db: ${r.database}`; name.append(sub); }
    const st = tr.insertCell();
    const badge = document.createElement('span'); badge.className = `sev ${r.severity}`; badge.textContent = SEV_LABEL[r.severity]; st.append(badge);
    if (r.note) { const td = tr.insertCell(); td.colSpan = f.columns.length; td.textContent = r.note; td.className = 'cell crit'; continue; }
    for (const c of f.columns) {
      const cell = r.checks[c.key] || { severity: 'na', text: '' };
      const td = tr.insertCell(); td.className = `cell ${cell.severity}`;
      td.textContent = cell.text;
      if (cell.details?.length) td.title = cell.details.join('\n');
    }
  }
  scroller.append(t);

  const det = document.createElement('details'); det.className = 'rules';
  const sum = document.createElement('summary'); sum.textContent = 'How these were judged';
  const ul = document.createElement('ul');
  for (const line of f.thresholds) { const li = document.createElement('li'); li.textContent = line; ul.append(li); }
  const note = document.createElement('p'); note.className = 'muted small';
  note.textContent = 'Thresholds are fixed rules in fleet.js, so results are repeatable. Hover a cell for details. Each database is read-only queried through its Genius Hub profile.';
  det.append(sum, ul, note);

  wrap.append(chips, scroller, det);
  $('welcome').hidden = true;
  $('messages').insertBefore(wrap, document.querySelector('.thinking'));
  scrollDown();
}

const scrollDown = () => { const m = $('messages'); m.scrollTop = m.scrollHeight; };

// Mirrors the server's detection loosely; the server is the authority and replies with a clear message if not.
const fleetLike = (q) => /\b(all|every|each|any)\s+(of\s+)?((my|the|our)\s+)?(db2\s+)?(databases?|dbs?|profiles?|instances?)\b|\bwhich\s+(databases|dbs)\b|\bdatabases\s+(that|with|where|without)\b|\b(across|fleet|estate|enterprise)\b/i.test(q);

async function ask(question) {
  if (state.busy || !question.trim()) return;
  if (!state.profile && !fleetLike(question)) return;
  state.busy = true; updateInputs();
  $('status').className = 'pill busy'; $('status').textContent = 'Working…';
  addMsg('user', question);
  $('input').value = ''; autosize();

  const toolsBox = document.createElement('div');
  toolsBox.className = 'tools';
  const thinking = document.createElement('div');
  thinking.className = 'thinking'; thinking.textContent = 'Thinking…';
  $('messages').append(thinking); scrollDown();
  const chips = new Map();

  const traces = new Map();
  const onEvent = (event, data) => {
    if (event === 'tool') {
      if (!toolsBox.isConnected) $('messages').insertBefore(toolsBox, thinking);
      let chip = chips.get(data.id);
      if (!chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.addEventListener('click', () => toggleTrace(chip, traces.get(data.id)));
        chips.set(data.id, chip); toolsBox.append(chip);
      }
      chip.className = `chip ${data.status}`;
      chip.textContent = data.ms != null ? `${data.name} · ${(data.ms / 1000).toFixed(1)}s` : data.name;
      if (data.args && Object.keys(data.args).length) chip.title = JSON.stringify(data.args, null, 2);
      if (data.status !== 'running') traces.set(data.id, data);
    } else if (event === 'progress') {
      thinking.textContent = data.text;
    } else if (event === 'fleet') {
      addFleet(data);
    } else if (event === 'table') {
      addTable(data);
    } else if (event === 'answer') {
      addMsg('bot', data.text, true);
    } else if (event === 'error') {
      addMsg('bot error', data.message);
    }
    scrollDown();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question }),
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      if (res.status === 401) { showLogin('Your session expired. Please sign in again.'); return; }
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    await readSse(res.body, onEvent);
  } catch (e) {
    addMsg('bot error', e.message);
  } finally {
    thinking.remove();
    state.busy = false;
    if (!$('app-view').hidden) { setProfile(state.profile); if (state.profile) $('input').focus(); }
  }
}

async function readSse(stream, onEvent) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}

function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

function toggleTrace(chip, d) {
  if (!d) return;
  const next = chip.parentElement.nextElementSibling;
  if (next?.classList.contains('trace') && next.dataset.for === d.id) { next.remove(); return; }
  document.querySelectorAll(`.trace[data-for="${d.id}"]`).forEach((n) => n.remove());
  const box = document.createElement('dl');
  box.className = 'trace'; box.dataset.for = d.id;
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'object') { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(v, null, 2); dd.append(pre); } else dd.textContent = v;
    box.append(dt, dd);
  };
  add('MCP tool', d.name);
  add('Arguments chosen by the model', d.args && Object.keys(d.args).length ? d.args : '(none \u2013 server defaults)');
  add('Result', `${d.status === 'error' ? 'Error' : 'Success'} in ${((d.ms || 0) / 1000).toFixed(2)}s${d.error ? ` \u2013 ${d.error}` : ''}`);
  chip.parentElement.after(box);
  scrollDown();
}

/* ---------------- guide ---------------- */
let appCfg = null;
const guide = $('guide');
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : 'unknown');

function selectTab(name) {
  guide.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  guide.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === 'session' || name === 'tools') loadConnection();
}

function fillCodeSamples() {
  if (!appCfg) return;
  const sub = (id, pairs) => {
    const el = $(id); let t = el.textContent;
    for (const [k, v] of pairs) t = t.split(k).join(v);
    el.textContent = t;
  };
  const common = [['<protocol>', appCfg.ghProtocol], ['<host>', appCfg.ghHost], ['<port>', appCfg.ghPort], ['<mcp-url>', appCfg.mcpUrl]];
  sub('code-token', common); sub('code-headers', common); sub('code-bob', common);
  $('tls-note').hidden = !appCfg.insecureTls;
  const dl = $('config-info'); dl.replaceChildren();
  for (const [k, v] of [
    ['Genius Hub API', `${appCfg.ghProtocol}://${appCfg.ghHost}:${appCfg.ghPort}`],
    ['MCP server', appCfg.mcpUrl],
    ['MCP transport', 'Streamable HTTP'],
    ['LLM endpoint', appCfg.llmBaseUrl],
    ['LLM model', appCfg.model],
    ['TLS verification (MCP)', appCfg.insecureTls ? 'off (self-signed certificate)' : 'on'],
  ]) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
}

async function loadConnection() {
  if ($('app-view').hidden) return;
  let c;
  try { c = await api('/api/connection'); } catch { return; }
  $('session-empty').hidden = true; $('session-info').hidden = false;
  const dl = $('session-info'); dl.replaceChildren();
  const rows = [
    ['Signed in as', c.user],
    ['Database profile', c.profile || '(none selected)'],
    ['Token (masked)', c.token.masked],
    ['Token requested', fmtTime(c.token.issuedAt)],
    ['Token expires', fmtTime(c.token.expiresAt)],
    ['MCP session id', c.mcpSessionId || '(stateless)'],
    ['Automatic reconnects', String(c.reconnects || 0)],
    ['Idle timeout', `${c.idleTimeoutMinutes} minutes`],
  ];
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }

  $('tools-empty').hidden = true;
  const sum = $('tools-summary'); sum.hidden = false;
  sum.textContent = `${c.toolCount} tools are published by the server. ${c.exposedCount} are offered to the AI model; session-management tools are handled by this app instead.`;
  const list = $('tools-list'); list.replaceChildren();
  for (const cat of c.categories) {
    const div = document.createElement('div'); div.className = 'cat';
    const h = document.createElement('h4'); h.textContent = cat.name; div.append(h);
    for (const t of cat.tools) {
      const row = document.createElement('div'); row.className = 'tool';
      const n = document.createElement('div'); n.className = 'name'; n.textContent = t.name;
      if (!t.exposed) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'app-managed'; n.append(b); }
      const d = document.createElement('div'); d.textContent = t.description;
      row.append(n, d); div.append(row);
    }
    list.append(div);
  }
}

document.querySelectorAll('[data-open-guide]').forEach((b) => b.addEventListener('click', () => { fillCodeSamples(); guide.showModal(); loadConnection(); }));
$('guide-close').addEventListener('click', () => guide.close());
guide.addEventListener('click', (e) => { if (e.target === guide) guide.close(); }); // click on backdrop
guide.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

/* ---------------- wiring ---------------- */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  $('login-error').hidden = true;
  try {
    const d = await api('/api/login', { method: 'POST', body: { userid: $('userid').value.trim(), password: $('password').value } });
    showApp(d.user, d.profiles);
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});

$('profile-select').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name) { setProfile(null); return; }
  const sel = e.target;
  sel.disabled = true;
  $('status').className = 'pill busy'; $('status').textContent = name === ALL ? 'Switching…' : `Connecting to ${name}…`;
  try {
    await api('/api/profile', { method: 'POST', body: { profile: name } });
    resetChat();
    setProfile(name);
    $('input').focus();
  } catch (err) {
    setProfile(null); sel.value = '';
    addMsg('bot error', `Could not connect to ${profileLabel(name)}: ${err.message}`);
  } finally {
    sel.disabled = false;
  }
});

$('refresh-profiles').addEventListener('click', async () => {
  try {
    const d = await api('/api/profiles');
    renderProfiles(d.profiles, d.active);
  } catch (err) { addMsg('bot error', err.message); }
});

$('new-chat').addEventListener('click', async () => {
  if (state.busy) return;
  await api('/api/reset', { method: 'POST' }).catch(() => {});
  resetChat();
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('composer').addEventListener('submit', (e) => { e.preventDefault(); ask($('input').value); });
$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('input').value); }
});

/* ---------------- boot ---------------- */
(async function init() {
  renderExamples();
  const cfg = await fetch('/api/config').then((r) => r.json());
  appCfg = cfg;
  $('gh-host').value = cfg.ghHost;
  fillCodeSamples();
  if (!cfg.llmConfigured) {
    $('login-error').hidden = false;
    $('login-error').textContent = 'Server warning: LLM_API_KEY is not set. Questions will fail until it is configured.';
  }
  const me = await fetch('/api/me').then((r) => r.json());
  if (me.user) {
    const d = await api('/api/profiles').catch(() => null);
    if (d) {
      showApp(me.user, d.profiles);
      if (me.profile) { $('profile-select').value = me.profile; setProfile(me.profile); }
      return;
    }
  }
  $('login-view').hidden = false;
})();

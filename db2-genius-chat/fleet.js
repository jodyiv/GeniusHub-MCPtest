// Enterprise ("fleet") questions: run the same MCP checks against EVERY Genius Hub profile and
// judge the results with fixed thresholds. Deliberately LLM-free: a loop over N databases is
// exact, fast, and cannot hallucinate. The LLM is only used for single-database questions.

export const ALL_PROFILES = '__all__';

export const THRESHOLDS = {
  spaceWarn: 80, spaceCrit: 95,          // tablespace utilisation %
  backupCritDays: 30,                    // older than this => critical (older than the window => warning)
  cpuAvgWarn: 70, cpuAvgCrit: 85, cpuMaxWarn: 90,
  memWarn: 85, memCrit: 95,
  bpWarn: 90, bpCrit: 80, bpMinReads: 1000, // buffer pool hit ratio %, ignore idle pools
};

// ------------------------------------------------------------------ question understanding
const FLEET_SCOPE = new RegExp([
  String.raw`\b(all|every|each|any)\s+(of\s+)?((my|the|our)\s+)?(db2\s+)?(databases?|dbs?|profiles?|instances?|systems?|environments?|servers?)\b`,
  String.raw`\bwhich\s+(db2\s+)?(databases|dbs|profiles|instances)\b`,
  String.raw`\bdatabases\s+(that|with|where|which|without|having)\b`,
  String.raw`\b(across|fleet|estate|enterprise)\b`,
].join('|'), 'i');

export const isFleetQuestion = (q) => FLEET_SCOPE.test(q);

const TOPIC_RULES = [
  ['space', /space|storage|capacity|tablespace|disk|\bfull\b/i],
  ['backup', /back(ed)?[\s-]?up/i],
  ['resources', /resource|\bcpu\b|memory|buffer\s?pool|\block|performance|\bslow\b|\bbusy\b|\bload\b/i],
  ['health', /health|resilien|critical|problem|wrong|overall/i],
];
const GENERIC = /issue|problem|attention|status|overview|summary|risk|check|exception|unhealthy|wrong/i;

/** @returns {{topics:Set<string>, generic:boolean}} */
export function detectTopics(q) {
  const topics = new Set(TOPIC_RULES.filter(([, re]) => re.test(q)).map(([t]) => t));
  return { topics, generic: GENERIC.test(q) };
}

/** "this week" -> 7, "last 3 days" -> 3, "today" -> 1, "this month" -> 30. Default 7. */
export function backupWindowDays(q) {
  const m = /(\d+)\s*(hour|day|week|month)s?/i.exec(q);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return unit === 'hour' ? Math.max(n / 24, 1 / 24) : n * { day: 1, week: 7, month: 30 }[unit];
  }
  if (/today|yesterday|24\s*hours|last day|daily/i.test(q)) return 1;
  if (/month/i.test(q)) return 30;
  return 7;
}

export const FLEET_HELP = `I'm in **enterprise view**, so I answer questions about *all* your databases at once. Try:

- Show all the databases with space issues.
- Show me all the databases with resource issues.
- Show me the databases that have not backed up this week.
- Which databases are unhealthy?
- Give me an overview of all my databases.

For a free-form question about one database (query tuning, locks, SQL, trends), pick that profile in the dropdown.`;

// ------------------------------------------------------------------ evaluators (pure)
const num = (x) => {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : null;
};
const ok = (text, extra = {}) => ({ severity: 'ok', text, ...extra });
const warn = (text, extra = {}) => ({ severity: 'warn', text, ...extra });
const crit = (text, extra = {}) => ({ severity: 'crit', text, ...extra });
const na = (text) => ({ severity: 'na', text });
const RANK = { na: -1, ok: 0, warn: 1, crit: 2 }; // 'no data' ranks below 'ok' so one missing check never hides a pass
const worst = (list) => list.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a), na(''));

export function evalSpace(res) {
  const rows = Array.isArray(res?.data) ? res.data : null;
  if (!rows) return na('No tablespace data');
  const measured = rows
    .map((r) => ({ r, pct: num(r.tbsp_utilization_percent) }))
    .filter((x) => x.pct !== null && x.r.utilization_applicable !== false)
    .sort((a, b) => b.pct - a.pct);
  if (!measured.length) return na('No measurable tablespaces');
  const { r, pct } = measured[0];
  const flagged = measured.filter((x) => x.pct >= THRESHOLDS.spaceWarn).length;
  const auto = r.tbsp_auto_resize_enabled ? ', auto-resize on' : '';
  const free = r.tbsp_free_size ? `, ${r.tbsp_free_size} free` : '';
  const more = flagged > 1 ? ` (+${flagged - 1} more ≥${THRESHOLDS.spaceWarn}%)` : '';
  const text = `${r.tbsp_name} ${pct.toFixed(1)}%${free}${auto}${more}`;
  if (pct >= THRESHOLDS.spaceCrit) return crit(text);
  if (pct >= THRESHOLDS.spaceWarn) return warn(text);
  return ok(`Highest: ${text}`);
}

export function parseDb2Time(s) {
  const m = typeof s === 'string' && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? new Date(`${m[1]}T${m[2]}`) : null;
}

export function fmtAge(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return 'under 1 hour ago';
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function evalBackup(res, windowDays, now = Date.now()) {
  const rows = Array.isArray(res?.data) ? res.data : [];
  const backups = rows
    .filter((r) => !r.operation || /backup/i.test(r.operation))
    .map((r) => ({ r, t: parseDb2Time(r.end_time) || parseDb2Time(r.start_time) }))
    .filter((x) => x.t)
    .sort((a, b) => b.t - a.t);
  if (!backups.length) return crit('No backup recorded in Db2 history');
  const { r, t } = backups[0];
  const ageMs = now - t.getTime();
  const kind = [r.objecttype, r.operationtype].filter(Boolean).join(', ');
  // Show the timestamp exactly as Db2 recorded it (local server time, no timezone conversion).
  const recorded = String(r.end_time || r.start_time).slice(0, 16);
  const text = `Last backup ${recorded} (${fmtAge(ageMs)}${kind ? `; ${kind}` : ''})`;
  const days = ageMs / 86_400_000;
  if (days > THRESHOLDS.backupCritDays) return crit(text);
  if (days > windowDays) return warn(text);
  return ok(text);
}

function evalCpu(res) {
  const st = res?.data?.stats;
  if (!st || !st.count || num(st.avg) === null) return na('No CPU data');
  const avg = num(st.avg);
  const max = num(st.max) ?? avg;
  const text = `CPU avg ${avg.toFixed(1)}%, peak ${max}%`;
  if (avg >= THRESHOLDS.cpuAvgCrit) return crit(text);
  if (avg >= THRESHOLDS.cpuAvgWarn || max >= THRESHOLDS.cpuMaxWarn) return warn(text);
  return ok(text);
}

function evalMemory(res) {
  const st = res?.data?.metrics?.average?.stats || res?.data?.stats;
  const avg = num(st?.avg);
  if (avg === null) return na('No memory data');
  const text = `Memory avg ${avg.toFixed(1)}%`;
  if (avg >= THRESHOLDS.memCrit) return crit(text);
  if (avg >= THRESHOLDS.memWarn) return warn(text);
  return ok(text);
}

function evalBufferPools(res) {
  const rows = Array.isArray(res?.data) ? res.data : [];
  const active = rows
    .map((r) => ({ r, hit: num(r.hit_ratio_percent), reads: num(r.total_logical_reads) ?? 0 }))
    .filter((x) => x.hit !== null && x.reads >= THRESHOLDS.bpMinReads)
    .sort((a, b) => a.hit - b.hit);
  if (!active.length) return na('No active buffer pools');
  const { r, hit } = active[0];
  const text = `${r.bp_name} hit ratio ${hit.toFixed(1)}%`;
  if (hit < THRESHOLDS.bpCrit) return crit(text);
  if (hit < THRESHOLDS.bpWarn) return warn(text);
  return ok(`Lowest pool hit ratio ${hit.toFixed(1)}%`);
}

function evalLocks(res) {
  const d = res?.data;
  if (!d || typeof d !== 'object') return na('No lock data');
  const waits = num(d.lock_wait_count) ?? 0;
  const roots = num(d.root_blocker_count) ?? 0;
  if (roots > 0) return crit(`${waits} lock wait(s), ${roots} root blocker(s)`);
  if (waits > 0) return warn(`${waits} lock wait(s)`);
  return ok('No lock waits');
}

/** Combine the four resource sub-checks into one cell. */
export function evalResources({ cpu, memory, bufferpool, locks }) {
  const parts = [evalCpu(cpu), evalMemory(memory), evalBufferPools(bufferpool), evalLocks(locks)];
  const real = parts.filter((p) => p.severity !== 'na');
  if (!real.length) return na('No resource data returned');
  const flagged = real.filter((p) => p.severity !== 'ok');
  const shown = flagged.length ? flagged : real;
  const w = worst(real);
  return { severity: w.severity, text: shown.map((p) => p.text).join(' · '), details: real.map((p) => p.text) };
}

// Messages that mean "the health tool could not look", not "the database is unhealthy".
const TOOL_PROBLEM = /^(unable to|error checking|failed to|could not|cannot)/i;

export function evalHealth(res, failed) {
  if (failed) return na('Health check unavailable');
  const d = res?.data;
  if (!d || typeof d !== 'object') return na('No health data');
  const status = String(d.status || 'unknown').toLowerCase();
  const warnings = Array.isArray(d.warnings) ? d.warnings : [];
  const errors = Array.isArray(d.errors) ? d.errors : [];

  const findings = warnings.filter((w) => !TOOL_PROBLEM.test(w));
  const couldNotRun = [...warnings.filter((w) => TOOL_PROBLEM.test(w)), ...errors];
  const details = [...findings, ...couldNotRun.map((e) => `Check could not run: ${e}`)];
  const skipped = couldNotRun.length ? ` (${couldNotRun.length} check${couldNotRun.length === 1 ? '' : 's'} could not run)` : '';

  if (findings.length) {
    const sev = /crit|fail|down/.test(status) && findings.length >= 3 ? crit : warn;
    return sev(`${findings.length} finding(s): ${findings.slice(0, 2).join('; ')}${findings.length > 2 ? '; …' : ''}${skipped}`, { details });
  }
  // Nothing wrong was actually found. Do not echo a "critical" caused only by failed checks.
  return ok(`No findings${skipped}`, { details });
}

// ------------------------------------------------------------------ runner
async function callJson(client, name, args) {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    let data = r.structuredContent;
    if (!data) {
      const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    return { data, failed: !!r.isError || data?.status === 'error', ms: Date.now() - t0 };
  } catch (e) {
    return { data: { message: e.message }, failed: true, ms: Date.now() - t0 };
  }
}

const errorText = (data) => String(data?.message || data?.error || data?.raw || 'tool error').split('\n')[0].slice(0, 160);

const COLUMN_LABEL = { space: 'Space', backup: 'Backup', resources: 'Resources', health: 'Health' };

function describeThresholds(topics, windowDays) {
  const t = THRESHOLDS;
  const out = [];
  if (topics.has('space')) out.push(`Space: warning at ≥${t.spaceWarn}% used, critical at ≥${t.spaceCrit}% (DMS tablespaces).`);
  if (topics.has('backup')) out.push(`Backup: warning if the last successful backup is older than ${windowDays} day(s), critical if older than ${t.backupCritDays} days or none on record.`);
  if (topics.has('resources')) out.push(`Resources (last 24 h): CPU avg ≥${t.cpuAvgWarn}% warn / ≥${t.cpuAvgCrit}% critical; buffer pool hit ratio <${t.bpWarn}% warn / <${t.bpCrit}% critical (pools with ≥${t.bpMinReads} logical reads); any lock wait warns.`);
  if (topics.has('health')) out.push('Health: status reported by the Genius Hub health-check tool.');
  return out;
}

/**
 * @param {object} o
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} o.client
 * @param {string[]} o.profiles
 * @param {Set<string>} o.topics
 * @param {number} o.windowDays
 * @param {(event:string, data:any)=>void} o.send
 * @param {()=>boolean} o.shouldStop
 */
export async function runFleet({ client, profiles, topics, windowDays, send, shouldStop }) {
  const now = Date.now();
  const columns = ['space', 'backup', 'resources', 'health'].filter((c) => topics.has(c));
  const rows = [];
  let seq = 0;

  for (const [i, profile] of profiles.entries()) {
    if (shouldStop()) return null;
    send('progress', { text: `Checking ${profile} (${i + 1} of ${profiles.length})…` });

    const call = async (name, args) => {
      const id = `fleet-${++seq}`;
      const label = `${name} @ ${profile}`;
      send('tool', { id, name: label, status: 'running' });
      const r = await callJson(client, name, args);
      send('tool', { id, name: label, status: r.failed ? 'error' : 'done', args, ms: r.ms, error: r.failed ? errorText(r.data) : undefined });
      return r;
    };

    const conn = await call('connect_to_profile', { profile_name: profile });
    if (conn.failed) {
      rows.push({
        profile, database: null, severity: 'crit', note: `Cannot connect: ${errorText(conn.data)}`,
        checks: Object.fromEntries(columns.map((c) => [c, na('Not checked')])),
      });
      continue;
    }

    const checks = {};
    if (topics.has('space')) {
      const r = await call('get_tablespace', { params: { order_by_utilization: true, limit: 100 } });
      checks.space = r.failed ? na(errorText(r.data)) : evalSpace(r.data);
    }
    if (topics.has('backup')) {
      const r = await call('fetch_db_history', { params: { show_backup: true, show_successful_only: true, limit: 20 } });
      checks.backup = r.failed ? na(errorText(r.data)) : evalBackup(r.data, windowDays, now);
    }
    if (topics.has('resources')) {
      const cpu = await call('get_cpu_summary', { params: { datetime_start: '24 hours ago', initial_message: 'Fleet check from {start_time} to {end_time}.' } });
      const memory = await call('get_memory_summary', { params: { datetime_start: '24 hours ago', initial_message: 'Fleet check from {start_time} to {end_time}.' } });
      const bp = await call('get_bufferpool_statistics', { params: { limit: 25 } });
      const locks = await call('analyze_lock_waits', { params: { limit: 5 } });
      checks.resources = evalResources({
        cpu: cpu.failed ? null : cpu.data, memory: memory.failed ? null : memory.data,
        bufferpool: bp.failed ? null : bp.data, locks: locks.failed ? null : locks.data,
      });
    }
    if (topics.has('health')) {
      const r = await call('perform_database_health_check', {});
      checks.health = evalHealth(r.data, r.failed);
    }

    const sev = worst(Object.values(checks)).severity;
    rows.push({
      profile, database: conn.data?.database || null, checks,
      severity: sev === 'na' ? 'na' : sev === 'ok' ? 'ok' : sev,
    });
  }

  rows.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.profile.localeCompare(b.profile));
  const counts = { total: rows.length, crit: 0, warn: 0, ok: 0, na: 0 };
  for (const r of rows) counts[r.severity] += 1;

  return {
    topics: columns,
    columns: columns.map((c) => ({ key: c, label: COLUMN_LABEL[c] })),
    windowDays,
    generatedAt: new Date(now).toISOString(),
    rows,
    counts,
    summary: buildSummary(rows, columns, windowDays),
    thresholds: describeThresholds(topics, windowDays),
  };
}

export function buildSummary(rows, columns, windowDays) {
  const scope = columns.map((c) => (c === 'backup' ? `backup (last ${windowDays} day${windowDays === 1 ? '' : 's'})` : c)).join(', ');
  const flagged = rows.filter((r) => r.severity === 'warn' || r.severity === 'crit');
  const head = flagged.length
    ? `**${flagged.length} of ${rows.length} database${rows.length === 1 ? '' : 's'} ${flagged.length === 1 ? 'needs' : 'need'} attention** (checked: ${scope}).`
    : `**All ${rows.length} databases passed** (checked: ${scope}).`;
  const lines = flagged.map((r) => {
    const issues = r.note
      ? [r.note]
      : Object.entries(r.checks)
        .filter(([, c]) => c.severity === 'warn' || c.severity === 'crit')
        .map(([k, c]) => `${COLUMN_LABEL[k].toLowerCase()}: ${c.text}`);
    return `- **${r.profile}** (${r.severity === 'crit' ? 'critical' : 'warning'}) – ${issues.join('; ')}`;
  });
  const unknown = rows.filter((r) => r.severity === 'na');
  const tail = unknown.length ? `\n\nNo data returned for: ${unknown.map((r) => r.profile).join(', ')}.` : '';
  return [head, ...lines].join('\n') + tail;
}

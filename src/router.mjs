// job-router core: tier decision, ladder walk, bucket checks, hard timeouts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const DEFAULTS = {
  codexBin: 'codex',
  sessionsDir: '~/.codex/sessions',
  logFile: '~/.local/state/job-router/log.jsonl',
  runTimeoutMs: 15 * 60 * 1000,
  probeTimeoutMs: 60 * 1000,
  killGraceMs: 5000,
  fallbackOnTimeout: true,
  sessionScanFiles: 20,
  jobTypes: { default: 'normal' },
  tiers: {},
  deniedModels: [],
  limitPatterns: ["you've hit your usage limit", 'usage limit', 'rate limit reached', 'quota exceeded', '429'],
  ollamaUrl: 'http://127.0.0.1:11434',
  localTimeoutMs: 5 * 60 * 1000,
  // Job types that must never run on a local model (art / brand illustration).
  noLocalJobTypes: ['brand-illustration', 'art'],
  rejectPatterns: ['model is not supported', 'unsupported model', 'model_not_found', 'does not exist or you do not have access', 'not supported when using codex', 'invalid model'],
};

// New path ~/.config/job-router/config.json; falls back to legacy ~/.config/codex-router/config.json if the new one is missing.
export function defaultConfigPath(env = process.env, home = os.homedir()) {
  const fromEnv = env.JOB_ROUTER_CONFIG || env.CODEX_ROUTER_CONFIG;
  if (fromEnv) return fromEnv;
  const primary = path.join(home, '.config', 'job-router', 'config.json');
  const legacy = path.join(home, '.config', 'codex-router', 'config.json');
  return !fs.existsSync(primary) && fs.existsSync(legacy) ? legacy : primary;
}

export function loadConfig(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new RouterError(`cannot read config ${file}: ${e.message}`, 2); }
  const cfg = { ...DEFAULTS, ...raw };
  if (!cfg.tiers || !Object.keys(cfg.tiers).length) throw new RouterError(`config ${file} has no tiers`, 2);
  return cfg;
}

export class RouterError extends Error {
  constructor(msg, code = 3, attempts = []) { super(msg); this.exitCode = code; this.attempts = attempts; }
}

export function resolveTier(cfg, jobType) {
  const jt = jobType || 'default';
  const tier = cfg.jobTypes[jt] ?? (cfg.tiers[jt] ? jt : cfg.jobTypes.default);
  if (!tier || !cfg.tiers[tier]) throw new RouterError(`no tier for job type "${jt}"`, 2);
  const denied = new Set((cfg.deniedModels || []).map((m) => m.toLowerCase()));
  const ladder = cfg.tiers[tier]
    .map((e) => (typeof e === 'string' ? { model: e } : e))
    .filter((e) => e.model && !denied.has(e.model.toLowerCase()))
    .filter((e) => !(isLocal(e) && noLocal(cfg, jt, tier)));
  const bad = ladder.find((e) => e.provider && !['codex', 'ollama'].includes(e.provider));
  if (bad) throw new RouterError(`tier "${tier}": unknown provider "${bad.provider}" for ${bad.model}`, 2);
  if (!ladder.length) throw new RouterError(`tier "${tier}" ladder is empty (after deniedModels)`, 2);
  return { jobType: jt, tier, ladder };
}

export const isLocal = (e) => e.provider === 'ollama';
const noLocal = (cfg, jt, tier) => (cfg.noLocalJobTypes ?? DEFAULTS.noLocalJobTypes).some((x) => x === jt || x === tier);

// Local model call via Ollama's HTTP API. Prompt = the last codex arg (the task text).
export async function runLocal(cfg, model, prompt) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.localTimeoutMs ?? DEFAULTS.localTimeoutMs);
  try {
    const res = await fetch(`${(cfg.ollamaUrl ?? DEFAULTS.ollamaUrl).replace(/\/$/, '')}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }), signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: 'local_failed', detail: `http ${res.status}` };
    let out; try { out = JSON.parse(text).response; } catch { out = undefined; }
    if (typeof out !== 'string' || !out.trim()) return { ok: false, reason: 'local_failed', detail: 'empty response' };
    return { ok: true, out, err: '', code: 0 };
  } catch (e) {
    return { ok: false, reason: ctl.signal.aborted ? 'local_timeout' : 'local_unavailable', detail: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// Latest rate_limits snapshot per limit_id from newest session jsonl files.
export function readBuckets(cfg) {
  const dir = expand(cfg.sessionsDir);
  const files = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { files.push([fs.statSync(p).mtimeMs, p]); } catch {} }
    }
  };
  walk(dir);
  files.sort((a, b) => a[0] - b[0]); // oldest first so newer overwrite
  const buckets = {};
  for (const [, f] of files.slice(-cfg.sessionScanFiles)) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('rate_limits')) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      findRateLimits(obj, (rl) => { if (rl.limit_id) buckets[rl.limit_id] = rl; });
    }
  }
  return buckets;
}
function findRateLimits(o, cb, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 8) return;
  if (o.rate_limits && typeof o.rate_limits === 'object') cb(o.rate_limits);
  for (const v of Object.values(o)) findRateLimits(v, cb, depth + 1);
}
export function bucketExhausted(rl) {
  if (!rl) return null;
  if (rl.rate_limit_reached_type) return `rate_limit_reached_type=${rl.rate_limit_reached_type}`;
  for (const w of ['primary', 'secondary']) {
    if (rl[w] && Number(rl[w].used_percent) >= 100) return `${w}.used_percent=${rl[w].used_percent}`;
  }
  return null;
}

export function classify(cfg, output) {
  const t = output.toLowerCase();
  if (cfg.limitPatterns.some((p) => t.includes(p.toLowerCase()))) return 'usage_limit';
  if (cfg.rejectPatterns.some((p) => t.includes(p.toLowerCase()))) return 'model_rejected';
  return null;
}

// Spawn with closed stdin in its own process group; hard timeout kills the group.
export function runWithTimeout(bin, args, timeoutMs, graceMs = 5000) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, done = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { return resolve({ code: 127, out, err: String(e), timedOut }); }
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const t = setTimeout(() => {
      timedOut = true; killGroup('SIGTERM');
      setTimeout(() => { if (!done) killGroup('SIGKILL'); }, graceMs).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); });
    child.on('close', (code, signal) => {
      done = true; clearTimeout(t);
      if (timedOut) killGroup('SIGKILL'); // reap any stragglers
      resolve({ code: code ?? (signal ? 128 : 1), signal, out, err, timedOut });
    });
  });
}

export function makeLogger(cfg) {
  const file = expand(cfg.logFile);
  return (ev) => {
    const rec = { ts: new Date().toISOString(), ...ev };
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch {}
  };
}

// Decide without spending: first ladder entry whose bucket isn't exhausted.
export function which(cfg, jobType) {
  const { tier, ladder, jobType: jt } = resolveTier(cfg, jobType);
  const buckets = readBuckets(cfg);
  const skipped = [];
  for (const e of ladder) {
    const why = e.bucket ? bucketExhausted(buckets[e.bucket]) : null;
    if (why) { skipped.push({ model: e.model, bucket: e.bucket, reason: why }); continue; }
    return { jobType: jt, tier, model: e.model, provider: e.provider || 'codex', skipped };
  }
  return { jobType: jt, tier, model: null, skipped };
}

export async function route(cfg, { jobType, codexArgs = [], probe = false, log = makeLogger(cfg) }) {
  const { tier, ladder, jobType: jt } = resolveTier(cfg, jobType);
  const attempts = [];
  const fall = (a) => { attempts.push(a); log({ event: 'fallback', jobType: jt, tier, ...a }); };
  for (const e of ladder) {
    if (isLocal(e)) {
      const last = codexArgs.at(-1);
      const prompt = last && !last.startsWith('-') ? last : null; // codex exec's trailing positional prompt
      if (!prompt) { fall({ model: e.model, reason: 'local_no_prompt' }); continue; }
      log({ event: 'attempt', jobType: jt, tier, model: e.model, provider: 'ollama' });
      const r = await runLocal(cfg, e.model, prompt);
      if (r.ok) { log({ event: 'success', jobType: jt, tier, model: e.model, provider: 'ollama' }); return { model: e.model, tier, attempts, ...r }; }
      fall({ model: e.model, reason: r.reason, detail: r.detail });
      continue;
    }
    const bucketWhy = e.bucket ? bucketExhausted(readBuckets(cfg)[e.bucket]) : null;
    if (bucketWhy) { fall({ model: e.model, reason: 'bucket_exhausted', detail: `${e.bucket}: ${bucketWhy}` }); continue; }
    if (probe) {
      const p = await runWithTimeout(expand(cfg.codexBin), ['exec', '--skip-git-repo-check', '-m', e.model, 'Reply with OK.'], cfg.probeTimeoutMs, cfg.killGraceMs);
      const why = p.timedOut ? 'probe_timeout' : classify(cfg, p.out + p.err) || (p.code !== 0 ? 'probe_failed' : null);
      if (why) { fall({ model: e.model, reason: why, exit: p.code }); continue; }
    }
    log({ event: 'attempt', jobType: jt, tier, model: e.model });
    const r = await runWithTimeout(expand(cfg.codexBin), ['exec', '-m', e.model, ...codexArgs], cfg.runTimeoutMs, cfg.killGraceMs);
    if (r.timedOut) {
      fall({ model: e.model, reason: 'timeout', timeoutMs: cfg.runTimeoutMs });
      if (cfg.fallbackOnTimeout) continue;
      throw new RouterError(`codex timed out after ${cfg.runTimeoutMs}ms on ${e.model}`, 124, attempts);
    }
    const why = classify(cfg, r.out + r.err);
    if (r.code === 0 && !why) { log({ event: 'success', jobType: jt, tier, model: e.model }); return { model: e.model, tier, attempts, ...r }; }
    if (why) { fall({ model: e.model, reason: why, exit: r.code }); continue; }
    log({ event: 'error', jobType: jt, tier, model: e.model, exit: r.code });
    throw Object.assign(new RouterError(`codex failed on ${e.model} (exit ${r.code}); not a limit/rejection, not falling back`, r.code || 1, attempts), { result: r });
  }
  log({ event: 'exhausted', jobType: jt, tier, attempts: attempts.length });
  throw new RouterError(`all ${ladder.length} model(s) in tier "${tier}" exhausted: ` + attempts.map((a) => `${a.model}=${a.reason}`).join(', '), 3, attempts);
}

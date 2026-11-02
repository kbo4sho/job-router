// job-router admission gate: per-class caps + shared CPU-unit pool + load check.
// No daemon: state is lease files in a state dir, mutated under an atomic mkdir lock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { expand } from './router.mjs';

export const EX_TEMPFAIL = 75;
export const CLASSES = ['ocr', 'pdf', 'build', 'codex', 'imagegen', 'ollama'];
const HEAVY = new Set(['build', 'ocr', 'pdf', 'imagegen', 'ollama']);

export class GateError extends Error {
  constructor(msg, exitCode = 2) { super(msg); this.exitCode = exitCode; }
}

// Test hooks: JOB_ROUTER_FAKE_NCPU / JOB_ROUTER_FAKE_LOAD override os.cpus()/os.loadavg()[0].
export function hostNcpu(env = process.env) {
  const n = Number(env.JOB_ROUTER_FAKE_NCPU);
  return n > 0 ? n : os.cpus().length;
}
export function hostLoad1(env = process.env) {
  const l = env.JOB_ROUTER_FAKE_LOAD;
  return l !== undefined && l !== '' && Number.isFinite(Number(l)) ? Number(l) : os.loadavg()[0];
}

export function defaultGateConfig(ncpu = hostNcpu()) {
  const pool = Math.max(1, ncpu - 2);
  const reserve = Math.max(1, Math.floor(pool / 4));
  const maxW = Math.max(1, pool - reserve); // heaviest weight a normal-priority job can be admitted with
  const w = (n) => Math.max(1, Math.min(maxW, n));
  return {
    stateDir: '~/.local/state/job-router/gate',
    poolUnits: pool,
    reserveCritical: reserve, // units only critical may use
    maxLoadPerCore: 1.0,                                  // heavy classes admitted only below this
    queueTimeoutMs: 30 * 60 * 1000,
    pollMs: 500,
    staleLockMs: 10 * 1000,
    exclusive: [['imagegen', 'ollama']],
    classes: {
      ocr: { cap: Math.max(1, Math.floor(pool / 3)), weight: 1, heavy: true, env: { OMP_THREAD_LIMIT: '1' } },
      pdf: { cap: Math.max(1, Math.floor(pool / 4)), weight: 1, heavy: true },
      build: { cap: 1, weight: w(Math.floor(pool / 2)), heavy: true },
      codex: { cap: 3, weight: 1, heavy: false },
      imagegen: { cap: 1, weight: w(4), heavy: true },
      ollama: { cap: 1, weight: w(4), heavy: true },
    },
  };
}

export function defaultGateConfigPath(env = process.env) {
  return env.JOB_ROUTER_GATE_CONFIG || path.join(os.homedir(), '.config', 'job-router', 'gate.json');
}

// Missing file = defaults. Unreadable/invalid file throws GateError (callers decide: critical bypasses).
export function loadGateConfig(file = defaultGateConfigPath(), env = process.env) {
  const base = defaultGateConfig(hostNcpu(env));
  let raw = {};
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new GateError(`cannot read gate config ${file}: ${e.message}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GateError(`gate config ${file} is not an object`);
  }
  const cfg = { ...base, ...raw, classes: { ...base.classes } };
  for (const [k, v] of Object.entries(raw.classes || {})) cfg.classes[k] = { ...(base.classes[k] || { cap: 1, weight: 1, heavy: true }), ...v };
  if (env.JOB_ROUTER_STATE_DIR) cfg.stateDir = env.JOB_ROUTER_STATE_DIR;
  const maxW = Math.max(1, cfg.poolUnits - (cfg.reserveCritical || 0));
  for (const [k, c] of Object.entries(cfg.classes)) {
    if (!(raw.classes?.[k]?.weight >= 0) && c.weight > maxW) c.weight = maxW; // re-clamp defaults
    if (c.weight > maxW) throw new GateError(`gate config: class ${k} weight ${c.weight} > poolUnits-reserveCritical (${maxW}); it could never be admitted`);
    if (!(c.cap >= 1) || !(c.weight >= 1)) throw new GateError(`gate config: class ${k} needs cap>=1 and weight>=1`);
  }
  if (!(cfg.poolUnits >= 1)) throw new GateError('gate config: poolUnits must be >= 1');
  return cfg;
}

export function stateDirOf(cfg, env = process.env) {
  return expand(env.JOB_ROUTER_STATE_DIR || cfg?.stateDir || defaultGateConfig().stateDir);
}

export function logEvent(stateDir, ev) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n');
  } catch {}
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bootTimeMs = () => Date.now() - os.uptime() * 1000;

function lockIsStale(dir, staleLockMs) {
  try {
    const st = fs.statSync(dir);
    if (Date.now() - st.mtimeMs > staleLockMs) return true;
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    return pid > 0 && !alive(pid);
  } catch { try { return Date.now() - fs.statSync(dir).mtimeMs > staleLockMs; } catch { return false; } }
}

const readOwner = (dir) => { try { return fs.readFileSync(path.join(dir, 'owner'), 'utf8'); } catch { return null; } };
const inoOf = (dir) => { try { return fs.statSync(dir).ino; } catch { return null; } };

// Steal a lock judged stale, identified by (inode, owner nonce) observed at judgement time.
// Rename to a unique tombstone; delete only if the tombstone is the exact lock we judged.
// Otherwise (someone's fresh lock) try to put it back; if lock.d already exists, leave the
// tombstone in place and report failure so the caller backs off. Never deletes a live lock.
export function tryStealLock(lock, observed) {
  const tomb = `${lock}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(lock, tomb); } catch { return false; }
  if (observed.ino != null && inoOf(tomb) === observed.ino && readOwner(tomb) === observed.owner) {
    fs.rmSync(tomb, { recursive: true, force: true });
    return true;
  }
  try { fs.renameSync(tomb, lock); } catch {}
  return false;
}

// Atomic mkdir mutex with stale-steal (dead holder pid or older than staleLockMs).
async function withLock(stateDir, staleLockMs, fn) {
  const lock = path.join(stateDir, 'lock.d');
  fs.mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + Math.max(staleLockMs * 3, 5000);
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
        fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      } catch {}
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const observed = { ino: inoOf(lock), owner: readOwner(lock) };
      if (lockIsStale(lock, staleLockMs)) {
        if (tryStealLock(lock, observed)) { logEvent(stateDir, { event: 'lock_steal' }); continue; }
      }
      if (Date.now() > deadline) throw new GateError(`gate lock ${lock} stuck`);
      await sleep(20 + Math.random() * 30);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

export function readLeases(stateDir) {
  const dir = path.join(stateDir, 'leases');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push({ file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }); }
    catch { out.push({ file: path.join(dir, n), corrupt: true }); }
  }
  return out;
}

export function isStale(l, boot = bootTimeMs()) {
  return l.corrupt || !(l.pid > 0) || (!alive(l.pid) && !(l.childPid > 0 && alive(l.childPid))) || (l.startedAt && l.startedAt < boot - 60000);
}

function reap(stateDir) {
  const live = [];
  for (const l of readLeases(stateDir)) {
    if (isStale(l)) { try { fs.unlinkSync(l.file); } catch {} logEvent(stateDir, { event: 'reap', leaseId: l.id, class: l.class, pid: l.pid }); }
    else live.push(l);
  }
  return live;
}

// Pure admission decision. Critical skips the class cap and load check and may use the reserve; GPU exclusivity still applies. Returns null when admitted, else a reason string.
export function decide(cfg, leases, { cls, prio, load1, ncpu }) {
  const c = cfg.classes[cls];
  const critical = prio === 'critical';
  const used = leases.reduce((s, l) => s + (l.weight || 0), 0);
  const inClass = leases.filter((l) => l.class === cls).length;
  if (!critical && inClass >= c.cap) return `class cap ${cls} ${inClass}/${c.cap}`;
  for (const grp of cfg.exclusive || []) {
    if (grp.includes(cls) && leases.some((l) => grp.includes(l.class))) return `exclusive with ${grp.join('/')}`;
  }
  const limit = critical ? cfg.poolUnits : cfg.poolUnits - (cfg.reserveCritical || 0);
  if (used + c.weight > Math.max(limit, critical ? 1 : 0)) return `pool ${used}+${c.weight}>${limit}`;
  if (!critical && (c.heavy ?? HEAVY.has(cls)) && load1 / ncpu >= cfg.maxLoadPerCore) return `load ${(load1 / ncpu).toFixed(2)}/core >= ${cfg.maxLoadPerCore}`;
  return null;
}

// Acquire a lease; resolves to { id, release(), inherited }. Throws GateError(75) on queue timeout.
export async function acquire(cfg, { cls, prio = 'normal', maxWaitMs, cmd, env = process.env,
  sample = () => ({ load1: hostLoad1(env), ncpu: hostNcpu(env) }) } = {}) {
  const stateDir = stateDirOf(cfg, env);
  // Inherit a lease of the same class or the same exclusive group (imagegen/ollama); others go through normal admission.
  const parentCls = env.JOB_ROUTER_LEASE?.split('.')[0];
  const related = parentCls && (parentCls === cls || (cfg.exclusive || []).some((g) => g.includes(cls) && g.includes(parentCls)));
  const parentFile = related && path.join(stateDir, 'leases', `${path.basename(env.JOB_ROUTER_LEASE)}.json`);
  let parentLive = false;
  if (related) { try { parentLive = !isStale(JSON.parse(fs.readFileSync(parentFile, 'utf8'))); } catch {} }
  if (related && !parentLive) logEvent(stateDir, { event: 'inherit_dangling', class: cls, leaseId: env.JOB_ROUTER_LEASE });
  if (related && parentLive) {
    logEvent(stateDir, { event: 'inherit', class: cls, leaseId: env.JOB_ROUTER_LEASE, pid: process.pid });
    return { id: env.JOB_ROUTER_LEASE, inherited: true, release() {}, setChildPid() {} };
  }
  const c = cfg.classes[cls];
  if (!c) throw new GateError(`unknown class "${cls}" (known: ${Object.keys(cfg.classes).join(', ')})`);
  const id = `${cls}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const leaseFile = path.join(stateDir, 'leases', `${id}.json`);
  const waitFile = path.join(stateDir, 'waiters', `${id}.json`);
  const wait = maxWaitMs ?? cfg.queueTimeoutMs;
  const t0 = Date.now();
  let lastReason = null, waiting = false;
  try {
    for (;;) {
      const s = sample();
      const reason = await withLock(stateDir, cfg.staleLockMs, () => {
        const leases = reap(stateDir);
        const why = decide(cfg, leases, { cls, prio, load1: s.load1, ncpu: s.ncpu });
        if (!why) {
          fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
          fs.writeFileSync(leaseFile, JSON.stringify({ id, pid: process.pid, class: cls, weight: c.weight, prio, startedAt: Date.now(), cmd }));
          const used = leases.reduce((a, l) => a + l.weight, 0) + c.weight;
          logEvent(stateDir, { event: 'acquire', class: cls, prio, leaseId: id, pid: process.pid, waitMs: Date.now() - t0, used, pool: cfg.poolUnits, load1: s.load1, ncpu: s.ncpu });
        }
        return why;
      });
      if (!reason) break;
      if (reason !== lastReason) { logEvent(stateDir, { event: 'deny', class: cls, prio, leaseId: id, reason, load1: s.load1 }); lastReason = reason; }
      if (!waiting) {
        waiting = true;
        try { fs.mkdirSync(path.dirname(waitFile), { recursive: true }); fs.writeFileSync(waitFile, JSON.stringify({ id, pid: process.pid, class: cls, prio, since: t0 })); } catch {}
      }
      if (Date.now() - t0 >= wait) {
        logEvent(stateDir, { event: 'timeout', class: cls, prio, leaseId: id, waitMs: Date.now() - t0, reason });
        throw new GateError(`queue timeout after ${Date.now() - t0}ms for class ${cls} (${reason})`, EX_TEMPFAIL);
      }
      await sleep(Math.min(cfg.pollMs * (0.75 + Math.random() * 0.5), Math.max(10, wait - (Date.now() - t0))));
    }
  } finally { if (waiting) try { fs.unlinkSync(waitFile); } catch {} }
  let released = false;
  const release = (extra = {}) => {
    if (released) return; released = true;
    try { fs.unlinkSync(leaseFile); } catch {}
    logEvent(stateDir, { event: 'release', class: cls, leaseId: id, durMs: Date.now() - t0, ...extra });
  };
  process.once('exit', () => release());
  const setChildPid = (childPid) => {
    try { const rec = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); rec.childPid = childPid; fs.writeFileSync(leaseFile, JSON.stringify(rec)); } catch {}
  };
  return { id, inherited: false, release, setChildPid, env: { ...(c.env || {}), JOB_ROUTER_LEASE: id } };
}

export function status(cfg, env = process.env) {
  const stateDir = stateDirOf(cfg, env);
  const boot = bootTimeMs();
  const leases = readLeases(stateDir).filter((l) => !isStale(l, boot));
  let waiters = [];
  try {
    waiters = fs.readdirSync(path.join(stateDir, 'waiters')).map((n) => {
      try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'waiters', n), 'utf8')); } catch { return null; }
    }).filter((w) => w && alive(w.pid));
  } catch {}
  const ncpu = hostNcpu(env), load1 = hostLoad1(env);
  const classes = {};
  for (const [k, c] of Object.entries(cfg.classes)) {
    classes[k] = { held: leases.filter((l) => l.class === k).length, cap: c.cap, weight: c.weight,
      heavy: c.heavy ?? HEAVY.has(k), waiting: waiters.filter((w) => w.class === k).length };
  }
  return {
    stateDir, ncpu, load1, loadPerCore: +(load1 / ncpu).toFixed(3), maxLoadPerCore: cfg.maxLoadPerCore,
    pool: { used: leases.reduce((s, l) => s + (l.weight || 0), 0), units: cfg.poolUnits, reserveCritical: cfg.reserveCritical },
    classes, exclusive: cfg.exclusive,
    leases: leases.map(({ file, ...l }) => ({ ...l, ageMs: Date.now() - l.startedAt })), waiters,
  };
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import os from 'node:os';
import { loadConfig, defaultConfigPath, which, route, RouterError } from '../src/router.mjs';
import { loadGateConfig, defaultGateConfigPath, acquire, status, stateDirOf, logEvent, GateError } from '../src/gate.mjs';

const USAGE = `usage:
  job-router which [--job TYPE] [--config FILE]          print chosen model (no spend)
  job-router run   [--job TYPE] [--probe] [--config FILE] [--prio P] -- <codex exec args...>
  job-router run   --class ocr|pdf|build|codex|imagegen|ollama [--prio critical] [--max-wait MS] -- <cmd args...>
  job-router status [--json]
  common: --gate-config FILE (default ~/.config/job-router/gate.json, env JOB_ROUTER_GATE_CONFIG)
exit: 0 ok, 2 config error, 3 ladder exhausted, 75 queue timeout, 124 timeout, else child exit code`;

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = { job: undefined, config: defaultConfigPath(), gateConfig: defaultGateConfigPath(), probe: false,
  cls: undefined, prio: 'normal', maxWait: undefined, json: false, rest: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { opts.rest = argv.slice(i + 1); break; }
  else if (a === '--job') opts.job = argv[++i];
  else if (a === '--config') opts.config = argv[++i];
  else if (a === '--gate-config') opts.gateConfig = argv[++i];
  else if (a === '--class') opts.cls = argv[++i];
  else if (a === '--prio') opts.prio = argv[++i];
  else if (a === '--max-wait') { const v = Number(argv[++i]); opts.maxWait = Number.isFinite(v) && v >= 0 ? v : undefined; }
  else if (a === '--json') opts.json = true;
  else if (a === '--probe') opts.probe = true;
  else { opts.rest = argv.slice(i); break; }
}
const critical = opts.prio === 'critical';

// Load gate config; on failure critical runs ungated (logged), everything else fails closed.
function gateOrBypass(cls) {
  try { return loadGateConfig(opts.gateConfig); }
  catch (e) {
    if (!critical) throw e;
    logEvent(stateDirOf(null), { event: 'gate_bypass', class: cls, prio: opts.prio, reason: e.message, pid: process.pid });
    console.error(`job-router: gate_bypass (critical): ${e.message}`);
    return null;
  }
}
async function gated(cls, cmdline) {
  const gcfg = gateOrBypass(cls);
  if (!gcfg) return { release() {}, setChildPid() {}, env: {} };
  return acquire(gcfg, { cls, prio: opts.prio, maxWaitMs: opts.maxWait, cmd: cmdline.join(' ').slice(0, 200) });
}

function runChild(bin, args, env, onSpawn = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    if (child.pid) onSpawn(child.pid);
    const fwd = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => { const h = () => { try { child.kill(s); } catch {} }; process.on(s, h); return [s, h]; });
    const done = (code) => { for (const [s, h] of fwd) process.off(s, h); resolve(code); };
    child.on('error', (e) => { console.error(`job-router: cannot run ${bin}: ${e.message}`); done(127); });
    child.on('exit', (code, sig) => done(code ?? 128 + (os.constants.signals[sig] || 0)));
  });
}

function printStatus(s) {
  console.log(`load ${s.load1.toFixed(2)} / ${s.ncpu} cpu = ${s.loadPerCore}/core (heavy max ${s.maxLoadPerCore})`);
  console.log(`pool ${s.pool.used}/${s.pool.units} units (critical reserve ${s.pool.reserveCritical})`);
  console.log('class      held/cap  weight  heavy  waiting');
  for (const [k, c] of Object.entries(s.classes)) console.log(`${k.padEnd(10)} ${`${c.held}/${c.cap}`.padEnd(9)} ${String(c.weight).padEnd(7)} ${String(c.heavy).padEnd(6)} ${c.waiting}`);
  for (const l of s.leases) console.log(`  lease ${l.id} pid=${l.pid} prio=${l.prio} age=${Math.round(l.ageMs / 1000)}s ${l.cmd || ''}`);
}

try {
  if (!['which', 'run', 'status'].includes(cmd)) { console.error(USAGE); process.exit(2); }
  if (cmd === 'status') {
    const s = status(loadGateConfig(opts.gateConfig));
    if (opts.json) console.log(JSON.stringify(s, null, 2)); else printStatus(s);
  } else if (cmd === 'which') {
    const cfg = loadConfig(opts.config);
    const w = which(cfg, opts.job);
    for (const s of w.skipped) console.error(`skip ${s.model}: ${s.bucket} ${s.reason}`);
    if (!w.model) throw new RouterError(`no available model in tier "${w.tier}"`, 3);
    console.log(w.model);
  } else if (opts.cls) {
    if (!opts.rest.length) throw new GateError('run --class needs a command after --', 2);
    const lease = await gated(opts.cls, opts.rest);
    const code = await runChild(opts.rest[0], opts.rest.slice(1), { ...process.env, ...lease.env }, (pid) => lease.setChildPid(pid));
    lease.release({ exit: code });
    process.exit(code);
  } else {
    const cfg = loadConfig(opts.config);
    if (!opts.rest.length) throw new RouterError('run needs codex exec args after --', 2);
    const lease = await gated('codex', ['codex', ...opts.rest]);
    Object.assign(process.env, lease.env); // nested job-router calls inherit the lease
    let childPid = null;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
      if (childPid) { try { process.kill(-childPid, 'SIGTERM'); } catch {} }
      lease.release({ signal: sig });
      process.exit(128 + os.constants.signals[sig]);
    });
    try {
      const r = await route(cfg, { jobType: opts.job, codexArgs: opts.rest, probe: opts.probe,
        onSpawn: (pid) => { childPid = pid; lease.setChildPid(pid); } });
      for (const a of r.attempts) console.error(`job-router: fell back from ${a.model} (${a.reason})`);
      console.error(`job-router: used ${r.model} (tier ${r.tier})`);
      process.stdout.write(r.out); process.stderr.write(r.err);
    } finally { lease.release(); }
  }
} catch (e) {
  if (e.result) { process.stdout.write(e.result.out); process.stderr.write(e.result.err); }
  console.error(`job-router: FAIL: ${e.message}`);
  process.exit(e.exitCode ?? 1);
}

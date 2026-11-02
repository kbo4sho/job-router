import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _setPsForTests, procStarts, status, procStart, LOCK_LOST, flockAcquire, logEvent, acquire, loadGateConfig, defaultGateConfig, readLeases, tryStealLock, writeAtomic, lockIsStale, isStale, withLock, commitLease, EX_TEMPFAIL } from '../src/gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'job-router.mjs');

function setup({ ncpu = 14, load = 0, gate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-'));
  const gateFile = path.join(dir, 'gate.json');
  if (gate !== undefined) fs.writeFileSync(gateFile, typeof gate === 'string' ? gate : JSON.stringify({ pollMs: 20, ...gate }));
  else fs.writeFileSync(gateFile, JSON.stringify({ pollMs: 20 }));
  const env = { ...process.env, JOB_ROUTER_STATE_DIR: path.join(dir, 'state'), JOB_ROUTER_GATE_CONFIG: gateFile,
    JOB_ROUTER_FAKE_NCPU: String(ncpu), JOB_ROUTER_FAKE_LOAD: String(load) };
  delete env.JOB_ROUTER_LEASE;
  const events = () => { try { return fs.readFileSync(path.join(dir, 'state', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  const cfg = () => loadGateConfig(gateFile, env);
  const acq = (cls, o = {}) => acquire(cfg(), { cls, env, maxWaitMs: 100, ...o });
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { dir, env, events, cfg, acq, cli };
}

test('defaults derive from cpu count (14 cpu)', () => {
  const d = defaultGateConfig(14);
  assert.equal(d.poolUnits, 12);
  assert.deepEqual(Object.fromEntries(Object.entries(d.classes).map(([k, c]) => [k, c.cap])),
    { ocr: 4, pdf: 3, build: 1, codex: 3, imagegen: 1, ollama: 1 });
  assert.equal(d.reserveCritical, 3); assert.equal(d.classes.build.weight, 6);
});

test('class cap is enforced', async () => {
  const { acq } = setup();
  const held = [await acq('pdf'), await acq('pdf'), await acq('pdf')];
  await assert.rejects(acq('pdf'), (e) => e.exitCode === EX_TEMPFAIL);
  held[0].release();
  (await acq('pdf')).release();
  held.slice(1).forEach((h) => h.release());
});

test('shared pool is enforced across classes; imagegen/ollama exclusive', async () => {
  const { acq } = setup(); // pool 12, reserve 3 -> 9 for normal
  const b = await acq('build');        // 6
  const i = await acq('imagegen', { maxWaitMs: 50 }).catch((e) => e); // 6+4 > 9
  assert.equal(i.exitCode, EX_TEMPFAIL);
  const o = await acq('ocr'); const o2 = await acq('ocr'); const o3 = await acq('ocr'); // 9
  await assert.rejects(acq('codex'), (e) => e.exitCode === EX_TEMPFAIL);
  [b, o, o2, o3].forEach((h) => h.release());
  const img = await acq('imagegen');
  await assert.rejects(acq('ollama'), (e) => /exclusive|TEMPFAIL|timeout/.test(e.message));
  img.release();
});

test('lease of a dead pid is reaped', async () => {
  const { acq, env } = setup();
  const dead = spawnSync('true').pid;
  const dir = path.join(env.JOB_ROUTER_STATE_DIR, 'leases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.dead.json'), JSON.stringify({ id: 'build.dead', pid: dead, class: 'build', weight: 6, startedAt: Date.now() }));
  const l = await acq('build');
  assert.ok(!readLeases(env.JOB_ROUTER_STATE_DIR).some((x) => x.id === 'build.dead'));
  l.release();
});

test('stale mkdir lock is stolen via tombstone rename', async () => {
  const { acq, env, events } = setup({ gate: { staleLockMs: 50 } });
  const lock = path.join(env.JOB_ROUTER_STATE_DIR, 'lock.d');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `${spawnSync('true').pid}.dead`); // dead owner pid
  (await acq('codex')).release();
  assert.deepEqual(fs.readdirSync(env.JOB_ROUTER_STATE_DIR).filter((n) => n.includes('.stale.')), []);
  assert.ok(events().some((e) => e.event === 'lock_steal'));
});

test('critical bypasses the load check and the reserve holds for it', async () => {
  const { acq } = setup({ load: 100 });
  await assert.rejects(acq('build'), (e) => e.exitCode === EX_TEMPFAIL); // hot: heavy normal blocked
  const { acq: acq2 } = setup();
  const held = [];
  for (let k = 0; k < 3; k++) held.push(await acq2('codex'));
  for (let k = 0; k < 4; k++) held.push(await acq2('ocr'));
  held.push(await acq2('pdf')); held.push(await acq2('pdf')); // 9 used = pool - reserve
  await assert.rejects(acq2('pdf'), (e) => e.exitCode === EX_TEMPFAIL);
  const c = await acq2('pdf', { prio: 'critical' }); // reserve units
  held.push(c); held.forEach((h) => h.release());
  const hot = await acq('build', { prio: 'critical' }); hot.release();
});

test('critical skips the class cap but respects GPU exclusivity', async () => {
  const { acq } = setup();
  const b = await acq('build');
  await assert.rejects(acq('build'), (e) => e.exitCode === EX_TEMPFAIL);
  const b2 = await acq('build', { prio: 'critical' }); // over cap 1, 12/12 units
  b.release(); b2.release();
  const o = await acq('ollama');
  await assert.rejects(acq('imagegen', { prio: 'critical', maxWaitMs: 50 }), (e) => e.exitCode === EX_TEMPFAIL);
  o.release();
});

test('high load blocks heavy classes only', async () => {
  const { acq } = setup({ load: 28 }); // 2.0/core
  (await acq('codex')).release();
  for (const cls of ['build', 'ocr', 'pdf', 'imagegen', 'ollama']) await assert.rejects(acq(cls, { maxWaitMs: 30 }), (e) => e.exitCode === EX_TEMPFAIL);
});

test('nested calls inherit the lease and do not deadlock', () => {
  const { cli } = setup();
  const r = cli(['run', '--class', 'build', '--max-wait', '500', '--', process.execPath, bin, 'run', '--class', 'build', '--max-wait', '500', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(r.status, 3, r.stderr);
});

test('queue timeout exits 75 and is logged', async () => {
  const { acq, cli, events } = setup();
  const l = await acq('build');
  const r = cli(['run', '--class', 'build', '--max-wait', '150', '--', 'true']);
  l.release();
  assert.equal(r.status, 75, r.stderr);
  const ev = events().map((e) => e.event);
  for (const k of ['acquire', 'release', 'deny', 'timeout']) assert.ok(ev.includes(k), k);
});

test('ocr child gets OMP_THREAD_LIMIT=1, stdio passes, exit code propagates', () => {
  const { cli } = setup();
  const r = cli(['run', '--class', 'ocr', '--', process.execPath, '-e', 'console.log(process.env.OMP_THREAD_LIMIT, !!process.env.JOB_ROUTER_LEASE); process.exit(5)'], { OMP_THREAD_LIMIT: '8' });
  assert.equal(r.status, 5); assert.equal(r.stdout.trim(), '1 true');
});

test('run --job --prio acquires a codex lease through the gate', () => {
  const { dir, cli, events } = setup();
  const fake = path.join(dir, 'codex.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("fake codex lease=" + process.env.JOB_ROUTER_LEASE);\n', { mode: 0o755 });
  const cfgFile = path.join(dir, 'router.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ codexBin: fake, sessionsDir: path.join(dir, 'nosessions'), logFile: path.join(dir, 'log.jsonl'), tiers: { normal: ['M1'] } }));
  const r = cli(['run', '--config', cfgFile, '--prio', 'normal', '--', 'hi']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fake codex lease=codex\./);
  const ev = events();
  assert.ok(ev.some((e) => e.event === 'acquire' && e.class === 'codex'));
  assert.ok(ev.some((e) => e.event === 'release' && e.class === 'codex'));
});

test('broken gate config: critical runs with logged bypass, normal fails closed', () => {
  const { cli, events } = setup({ gate: '{not json' });
  const ok = cli(['run', '--class', 'build', '--prio', 'critical', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(events().some((e) => e.event === 'gate_bypass'));
  assert.equal(cli(['run', '--class', 'build', '--', 'true']).status, 2);
});

test('status --json reports leases, pool, load and caps', async () => {
  const { acq, cli } = setup({ load: 7 });
  const l = await acq('codex');
  const s = JSON.parse(cli(['status', '--json']).stdout);
  l.release();
  assert.equal(s.classes.codex.held, 1); assert.equal(s.pool.used, 1); assert.equal(s.pool.units, 12);
  assert.equal(s.loadPerCore, 0.5); assert.equal(s.classes.ocr.cap, 4);
});

test('lease with dead wrapper but live child pid is not reaped; child pid recorded', async () => {
  const { acq, env, cli } = setup();
  const dead = spawnSync('true').pid;
  const dir = path.join(env.JOB_ROUTER_STATE_DIR, 'leases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.orphan.json'), JSON.stringify({ id: 'build.orphan', pid: dead, childPid: process.pid, class: 'build', weight: 6, startedAt: Date.now() }));
  await assert.rejects(acq('build', { maxWaitMs: 50 }), (e) => e.exitCode === EX_TEMPFAIL);
  fs.unlinkSync(path.join(dir, 'build.orphan.json'));
  const r = cli(['run', '--class', 'codex', '--', process.execPath, '-e',
    `const fs=require('fs'),p=require('path');const d=${JSON.stringify(dir)};const l=JSON.parse(fs.readFileSync(p.join(d,fs.readdirSync(d)[0])));console.log(l.childPid===process.pid)`]);
  assert.equal(r.stdout.trim(), 'true', r.stderr);
});

test('invalid --max-wait exits 2 with a clear message', () => {
  const { cli } = setup();
  for (const v of ['abc', '-5']) {
    const r = cli(['run', '--class', 'codex', '--max-wait', v, '--', 'true']);
    assert.equal(r.status, 2); assert.match(r.stderr, /--max-wait must be a non-negative number/);
  }
});

test('nested call of a different class takes its own lease and is capped', async () => {
  const { acq, cli, events } = setup();
  const inner = [process.execPath, bin, 'run', '--class', 'build', '--max-wait', '150', '--', process.execPath, '-e', 'process.exit(0)'];
  const ok = cli(['run', '--class', 'codex', '--', ...inner]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(events().some((e) => e.event === 'acquire' && e.class === 'build'));
  const held = await acq('build');
  const capped = cli(['run', '--class', 'codex', '--', ...inner]);
  held.release();
  assert.equal(capped.status, 75, capped.stderr);
});

test('lock steal never deletes a lock whose owner nonce differs from what was judged stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-lock-'));
  const lock = path.join(dir, 'lock.d');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), 'fresh.owner');
  const ino = fs.statSync(lock).ino;
  assert.equal(tryStealLock(lock, { ino, owner: 'old.owner' }), false);
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 'fresh.owner'); // put back intact
  fs.mkdirSync(path.join(dir, 'other')); fs.writeFileSync(path.join(dir, 'other', 'owner'), 'x');
  assert.equal(tryStealLock(lock, { ino: fs.statSync(path.join(dir, 'other')).ino, owner: 'fresh.owner' }), false);
  assert.ok(fs.existsSync(lock));
  assert.equal(tryStealLock(lock, { ino: fs.statSync(lock).ino, owner: 'fresh.owner' }), true);
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.stale.')), []);
});

test('small-pool host (4 cpu): default weights fit pool-reserve; oversized user weight fails closed', async () => {
  const d = defaultGateConfig(4);
  for (const c of Object.values(d.classes)) assert.ok(c.weight <= d.poolUnits - d.reserveCritical);
  const { acq } = setup({ ncpu: 4 });
  for (const cls of ['build', 'imagegen']) (await acq(cls)).release();
  const bad = setup({ ncpu: 4, gate: { classes: { build: { weight: 5 } } } });
  assert.throws(() => bad.cfg(), /could never be admitted/);
  assert.equal(bad.cli(['run', '--class', 'build', '--', 'true']).status, 2);
});

test('nested ollama under an imagegen lease inherits it (same exclusive group)', () => {
  const { cli, events } = setup();
  const r = cli(['run', '--class', 'imagegen', '--', process.execPath, bin, 'run', '--class', 'ollama', '--max-wait', '0', '--',
    process.execPath, '-e', 'process.exit(0)']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(events().some((e) => e.event === 'inherit' && e.class === 'ollama' && /^imagegen\./.test(e.leaseId)));
});

test('GPU group blocks a second critical of the same class', async () => {
  const { acq } = setup();
  const i = await acq('imagegen');
  await assert.rejects(acq('imagegen', { prio: 'critical', maxWaitMs: 50 }), (e) => e.exitCode === EX_TEMPFAIL);
  await assert.rejects(acq('ollama', { prio: 'critical', maxWaitMs: 50 }), (e) => e.exitCode === EX_TEMPFAIL);
  i.release();
});

test('dangling JOB_ROUTER_LEASE is not inherited; normal admission applies', async () => {
  const { acq, env } = setup();
  const held = await acq('build');
  const e2 = { ...env, JOB_ROUTER_LEASE: 'build.999999.deadbeef' };
  await assert.rejects(acq('build', { env: e2, maxWaitMs: 50 }), (e) => e.exitCode === EX_TEMPFAIL);
  held.release();
  const l = await acq('build', { env: e2 });
  assert.equal(l.inherited, false); l.release();
});

test('run --job: signal kills codex child group, releases lease, child pid recorded', async () => {
  const { dir, env, events } = setup();
  const fake = path.join(dir, 'codex.mjs'), pidFile = path.join(dir, 'cpid');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(()=>{},1000);\n`.replace('require', "(await import('node:module')).createRequire(import.meta.url)"), { mode: 0o755 });
  const cfgFile = path.join(dir, 'router.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ codexBin: fake, sessionsDir: path.join(dir, 'ns'), logFile: path.join(dir, 'log.jsonl'), tiers: { normal: ['M1'] } }));
  const p = spawn(process.execPath, [bin, 'run', '--config', cfgFile, '--prio', 'normal', '--', 'hi'], { env, stdio: 'ignore' });
  const t0 = Date.now();
  while (!fs.existsSync(pidFile) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
  const cpid = Number(fs.readFileSync(pidFile, 'utf8'));
  const lease = readLeases(env.JOB_ROUTER_STATE_DIR)[0];
  assert.equal(lease.childPid, cpid);
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  p.kill('SIGTERM');
  assert.equal(await exited, 143);
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  for (const t1 = Date.now(); !gone(cpid) && Date.now() - t1 < 3000;) await new Promise((r) => setTimeout(r, 25));
  assert.ok(gone(cpid), 'codex child should be gone'); // polled: Brick can be slow to reap under load
  assert.deepEqual(readLeases(env.JOB_ROUTER_STATE_DIR), []);
  assert.ok(events().some((e) => e.event === 'release' && e.signal === 'SIGTERM'));
});

test('writeAtomic leaves no temp files; readLeases ignores temp/partial files', () => {
  const { env } = setup();
  const dir = path.join(env.JOB_ROUTER_STATE_DIR, 'leases'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'codex.1.a.json');
  for (let k = 0; k < 50; k++) writeAtomic(f, JSON.stringify({ id: 'x', pad: 'y'.repeat(k * 100) }));
  assert.deepEqual(fs.readdirSync(dir), ['codex.1.a.json']);
  fs.writeFileSync(path.join(dir, 'codex.2.b.json.tmp.9.ab'), '{"partial');
  fs.writeFileSync(path.join(dir, 'codex.3.c.tmp.9.ab.json'), '{"partial');
  const ls = readLeases(env.JOB_ROUTER_STATE_DIR);
  assert.equal(ls.length, 1); assert.ok(!ls[0].corrupt);
});

test('a live-owner lock is never stale, even when old; missing owner falls back to age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-ls-'));
  const lock = path.join(dir, 'lock.d'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}.n`);
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(lock, old, old);
  assert.equal(lockIsStale(lock, 50), false);
  fs.writeFileSync(path.join(lock, 'owner'), `${spawnSync('true').pid}.n`);
  assert.equal(lockIsStale(lock, 50), true);
  fs.unlinkSync(path.join(lock, 'owner'));
  fs.utimesSync(lock, old, old); // unlink bumps dir mtime
  assert.equal(lockIsStale(lock, 50), true); // old, no owner
  fs.utimesSync(lock, new Date(), new Date());
  assert.equal(lockIsStale(lock, 60000), false); // fresh, no owner yet
});

test('release with a foreign nonce leaves lock.d; ownership-lost commit aborts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-rel-'));
  const leaseFile = path.join(dir, 'leases', 'codex.1.x.json');
  const res = await withLock(dir, 10000, (owns) => {
    assert.equal(owns(), true);
    fs.writeFileSync(path.join(dir, 'lock.d', 'owner'), 'foreign.nonce');
    assert.equal(owns(), false);
    return commitLease(owns, leaseFile, { id: 'x' });
  });
  assert.equal(res, false);
  assert.ok(!fs.existsSync(leaseFile));
  assert.equal(fs.readFileSync(path.join(dir, 'lock.d', 'owner'), 'utf8'), 'foreign.nonce');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.stale.')), []);
});

test('setChildPid after release does not resurrect the lease', async () => {
  const { acq, env } = setup();
  const l = await acq('codex');
  l.release(); l.setChildPid(process.pid);
  assert.deepEqual(readLeases(env.JOB_ROUTER_STATE_DIR), []);
});

test('reserveCritical outside [0, poolUnits) is invalid config (exit 2)', () => {
  for (const reserveCritical of [12, -1, 'x']) {
    const bad = setup({ gate: { reserveCritical } });
    assert.throws(() => bad.cfg(), /reserveCritical/);
    assert.equal(bad.cli(['run', '--class', 'codex', '--', 'true']).status, 2);
  }
  assert.doesNotThrow(() => setup({ gate: { reserveCritical: 0 } }).cfg());
});

test('owner-file write failure drops lock.d and retries, never a silent hold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-ow-'));
  let fails = 2;
  const orig = fs.writeFileSync;
  const m = mock.method(fs, 'writeFileSync', function (f, ...a) {
    if (String(f).includes(`lock.d${path.sep}owner`) && fails > 0) { fails--; throw new Error('ENOSPC fake'); }
    return orig.call(fs, f, ...a);
  });
  try {
    const owned = await withLock(dir, 10000, (owns) => owns());
    assert.equal(owned, true); assert.equal(fails, 0);
  } finally { m.mock.restore(); }
  assert.ok(!fs.existsSync(path.join(dir, 'lock.d')));
  assert.ok(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('lock_owner_write_failed'));
});

test('persistent lock loss still honours the wait timeout (75)', async () => {
  const { acq } = setup();
  const orig = fs.readFileSync;
  const m = mock.method(fs, 'readFileSync', function (f, ...a) {
    if (String(f).endsWith(`lock.d${path.sep}owner`)) return 'foreign.nonce';
    return orig.call(fs, f, ...a);
  });
  try { await assert.rejects(acq('codex', { maxWaitMs: 150 }), (e) => e.exitCode === EX_TEMPFAIL && /lock lost/.test(e.message)); }
  finally { m.mock.restore(); }
});

test('run --class: SIGTERM kills the whole child process group and releases the lease', async () => {
  const { dir, env, events } = setup();
  const gpid = path.join(dir, 'gpid');
  const p = spawn(process.execPath, [bin, 'run', '--class', 'codex', '--', 'sh', '-c', `sleep 30 & echo $! > ${gpid}; wait`], { env, stdio: 'ignore' });
  const t0 = Date.now();
  while (!(fs.existsSync(gpid) && fs.readFileSync(gpid, 'utf8').trim()) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
  const g = Number(fs.readFileSync(gpid, 'utf8'));
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  p.kill('SIGTERM');
  assert.equal(await exited, 143);
  await new Promise((r) => setTimeout(r, 150));
  assert.throws(() => process.kill(g, 0), 'grandchild should be gone');
  assert.deepEqual(readLeases(env.JOB_ROUTER_STATE_DIR), []);
  assert.ok(events().some((e) => e.event === 'release' && e.class === 'codex'));
});

test('--prio accepts only normal or critical', () => {
  const { cli } = setup();
  const r = cli(['run', '--class', 'codex', '--prio', 'high', '--', 'true']);
  assert.equal(r.status, 2); assert.match(r.stderr, /--prio must be normal or critical/);
  assert.equal(cli(['run', '--class', 'codex', '--prio', 'normal', '--', 'true']).status, 0);
});

test('pre-boot lock: live owner NOT stale, dead or missing owner stale (injected boot time)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-boot-'));
  const lock = path.join(dir, 'lock.d'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}.n`);
  assert.equal(lockIsStale(lock, 1e9, fs.statSync(lock).mtimeMs + 1000), false);
  fs.writeFileSync(path.join(lock, 'owner'), `${spawnSync('true').pid}.n`);
  assert.equal(lockIsStale(lock, 1e9, fs.statSync(lock).mtimeMs + 1000), true);
  fs.unlinkSync(path.join(lock, 'owner'));
  assert.equal(lockIsStale(lock, 1e9, fs.statSync(lock).mtimeMs + 1000), true);
  assert.equal(lockIsStale(lock, 1e9, fs.statSync(lock).mtimeMs - 1000), false);
});

test('pre-boot lease: live pid NOT stale, dead pid stale', () => {
  const boot = Date.now(), old = boot - 3600e3;
  assert.equal(isStale({ pid: process.pid, startedAt: old }), false);
  assert.equal(isStale({ pid: spawnSync('true').pid, childPid: process.pid, startedAt: old }), false);
  assert.equal(isStale({ pid: spawnSync('true').pid, startedAt: old }), true);
});

test('legacy run --job (no --class/--prio) is ungated: broken gate.json and full pool do not matter', async () => {
  const { dir, env, cli, events } = setup({ gate: '{broken' });
  const fake = path.join(dir, 'codex.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("legacy ok lease=" + (process.env.JOB_ROUTER_LEASE || "none"));\n', { mode: 0o755 });
  const cfgFile = path.join(dir, 'router.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ codexBin: fake, sessionsDir: path.join(dir, 'ns'), logFile: path.join(dir, 'log.jsonl'), tiers: { normal: ['M1'] } }));
  // fill the codex class with live leases held by this process
  const ld = path.join(env.JOB_ROUTER_STATE_DIR, 'leases'); fs.mkdirSync(ld, { recursive: true });
  for (let k = 0; k < 12; k++) fs.writeFileSync(path.join(ld, `codex.${k}.json`), JSON.stringify({ id: `codex.${k}`, pid: process.pid, class: 'codex', weight: 1, startedAt: Date.now() }));
  for (const args of [['run', '--config', cfgFile, '--', 'hi'], ['run', '--job', 'normal', '--config', cfgFile, '--', 'hi']]) {
    const r = cli(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /legacy ok lease=none/);
  }
  assert.deepEqual(events(), []);
});

test('stuck live-owner lock: --max-wait 300 exits 75 in about 300 ms', () => {
  const { env, cli } = setup();
  const lock = path.join(env.JOB_ROUTER_STATE_DIR, 'lock.d');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}.held`);
  const t0 = Date.now();
  const r = cli(['run', '--class', 'codex', '--max-wait', '300', '--', 'true']);
  const dt = Date.now() - t0;
  assert.equal(r.status, 75, r.stderr);
  assert.ok(dt < 2500, `took ${dt}ms`);
  assert.ok(fs.existsSync(lock));
});

test('legacy run --json foo (no --) forwards --json foo to codex exactly as main', () => {
  const { dir, cli, events } = setup({ gate: '{broken' });
  const fake = path.join(dir, 'codex.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const cfgFile = path.join(dir, 'router.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ codexBin: fake, sessionsDir: path.join(dir, 'ns'), logFile: path.join(dir, 'log.jsonl'), tiers: { normal: ['M1'] } }));
  let r = cli(['run', '--config', cfgFile, '--json', 'foo']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['exec', '-m', 'M1', '--json', 'foo']);
  r = cli(['run', '--config', cfgFile, '--max-wait', 'x', 'foo']); // stray gate flag passes through
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['exec', '-m', 'M1', '--max-wait', 'x', 'foo']);
  assert.deepEqual(events(), []);
});

test('broken gate config + critical: unknown --class still exits 2, no bypass', () => {
  const { cli, events } = setup({ gate: '{not json' });
  const r = cli(['run', '--class', 'ocrr', '--prio', 'critical', '--', 'true']);
  assert.equal(r.status, 2); assert.match(r.stderr, /unknown class "ocrr"/);
  assert.equal(cli(['run', '--class', 'ocr', '--prio', 'bogus', '--', 'true']).status, 2);
  assert.ok(!events().some((e) => e.event === 'gate_bypass'));
});

test('events.jsonl rotates by size, keeping one old file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-rot-'));
  const prev = process.env.JOB_ROUTER_EVENTS_MAX_BYTES;
  process.env.JOB_ROUTER_EVENTS_MAX_BYTES = '500';
  try { for (let k = 0; k < 60; k++) logEvent(dir, { event: 'x', k, pad: 'p'.repeat(40) }); }
  finally { if (prev === undefined) delete process.env.JOB_ROUTER_EVENTS_MAX_BYTES; else process.env.JOB_ROUTER_EVENTS_MAX_BYTES = prev; }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['events.jsonl', 'events.jsonl.1']);
  assert.ok(fs.statSync(path.join(dir, 'events.jsonl')).size < 600);
  const last = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').pop();
  assert.equal(JSON.parse(last).k, 59);
});

test('deny is logged once per reason category, not per load change', async () => {
  const { cfg, env, events } = setup();
  let load = 20;
  await assert.rejects(acquire(cfg(), { cls: 'build', env, maxWaitMs: 200, sample: () => ({ load1: (load += 0.37), ncpu: 14 }) }),
    (e) => e.exitCode === EX_TEMPFAIL);
  assert.equal(events().filter((e) => e.event === 'deny').length, 1);
});

const flockBusy = (file) => spawnSync('/usr/bin/perl', ['-e', 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or exit 3; exit(flock($f, LOCK_EX|LOCK_NB) ? 0 : 1)', file]).status === 1;

test('lock is taken via the perl flock helper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-fl-'));
  const busy = await withLock(dir, 10000, () => flockBusy(path.join(dir, 'lock.flock')));
  assert.equal(busy, true);
  await new Promise((r) => setTimeout(r, 200)); // helper exits after stdin closes
  assert.equal(flockBusy(path.join(dir, 'lock.flock')), false);
  const ev = path.join(dir, 'events.jsonl');
  assert.ok(!fs.existsSync(ev) || !fs.readFileSync(ev, 'utf8').includes('lock_fallback'));
});

test('SIGKILLed lock holder: flock is released and the next acquirer gets the lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-fk-'));
  const held = path.join(dir, 'held');
  const gate = new URL('../src/gate.mjs', import.meta.url).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { withLock } from ${JSON.stringify(gate)}; import fs from 'node:fs';
     await withLock(${JSON.stringify(dir)}, 10000, () => { fs.writeFileSync(${JSON.stringify(held)}, 'x'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); });`], { stdio: 'ignore' });
  for (const t1 = Date.now(); !fs.existsSync(held) && Date.now() - t1 < 5000;) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(held));
  assert.equal(await withLock(dir, 10000, () => 'nope', 300), LOCK_LOST); // held: we time out
  holder.kill('SIGKILL');
  await new Promise((r) => holder.on('exit', r));
  const t2 = Date.now();
  assert.equal(await withLock(dir, 10000, (owns) => owns(), 5000), true);
  assert.ok(Date.now() - t2 < 3000);
});

test('missing perl falls back to the mkdir lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrg-fb-'));
  assert.equal(await flockAcquire(dir, 1000, { perl: path.join(dir, 'no-perl') }), null);
  const prev = process.env.JOB_ROUTER_PERL;
  process.env.JOB_ROUTER_PERL = path.join(dir, 'no-perl');
  try { assert.equal(await withLock(dir, 10000, (owns) => owns()), true); }
  finally { if (prev === undefined) delete process.env.JOB_ROUTER_PERL; else process.env.JOB_ROUTER_PERL = prev; }
  assert.ok(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('lock_fallback'));
  assert.ok(!fs.existsSync(path.join(dir, 'lock.d')));
});

test('weight_clamped: logged after a successful acquire of the clamped class only; status read-only', async () => {
  const big = setup();                       // 14 cpu: nothing clamped
  (await big.acq('build')).release();
  assert.ok(!big.events().some((e) => e.event === 'weight_clamped'));
  const t = setup({ gate: { reserveCritical: 8 } }); // pool 12, max weight 4 -> build 6 clamped
  t.cfg();
  assert.equal(t.cli(['status', '--json']).status, 0);
  assert.deepEqual(t.events(), []);                  // read-only
  assert.equal(t.cli(['run', '--class', 'codex', '--', 'true']).status, 0);
  assert.ok(!t.events().some((e) => e.event === 'weight_clamped')); // other class: no build clamp
  (await t.acq('build')).release();
  const ev = t.events().filter((e) => e.event === 'weight_clamped');
  assert.deepEqual(ev.map((e) => [e.class, e.from, e.to]), [['build', 6, 4]]);
  const user = setup({ gate: { reserveCritical: 8, classes: { build: { weight: 3 } } } }); // explicit weight: no event
  (await user.acq('build')).release();
  assert.ok(!user.events().some((e) => e.event === 'weight_clamped'));
});

test('weight_clamped: timed-out run logs nothing; poolUnits override with default reserve logs nothing', async () => {
  const t = setup({ gate: { reserveCritical: 8 } });
  const held = await t.acq('build');
  const r = t.cli(['run', '--class', 'build', '--max-wait', '100', '--', 'true']);
  held.release();
  assert.equal(r.status, 75);
  assert.equal(t.events().filter((e) => e.event === 'weight_clamped').length, 1); // only the holder's acquire
  for (const poolUnits of [8, 20]) {
    const p = setup({ gate: { poolUnits } });
    (await p.acq('build')).release();
    assert.ok(!p.events().some((e) => e.event === 'weight_clamped'), `poolUnits ${poolUnits}`);
  }
});

const watchdogs = (tag) => spawnSync('pgrep', ['-f', `job-router-watchdog:${tag}`], { encoding: 'utf8' }).stdout.trim();

test('watchdog: SIGKILLed wrapper -> child group killed, lease reapable; normal run leaves no watchdog', async () => {
  const { dir, env, cli, events } = setup();
  const gpid = path.join(dir, 'gpid');
  const p = spawn(process.execPath, [bin, 'run', '--class', 'codex', '--', 'sh', '-c', `sleep 30 & echo $! > ${gpid}; wait`],
    { env: { ...env, JOB_ROUTER_WATCHDOG_GRACE_MS: '1000' }, stdio: 'ignore' });
  for (const t0 = Date.now(); !(fs.existsSync(gpid) && fs.readFileSync(gpid, 'utf8').trim()) && Date.now() - t0 < 5000;) await new Promise((r) => setTimeout(r, 25));
  const g = Number(fs.readFileSync(gpid, 'utf8'));
  const lease = readLeases(env.JOB_ROUTER_STATE_DIR)[0];
  assert.ok(watchdogs(lease.id), 'watchdog running while job runs');
  p.kill('SIGKILL');
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  for (const t1 = Date.now(); !(gone(g) && gone(lease.childPid)) && Date.now() - t1 < 5000;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gone(g), 'grandchild killed'); assert.ok(gone(lease.childPid), 'child killed');
  assert.equal(isStale(readLeases(env.JOB_ROUTER_STATE_DIR)[0]), true);
  for (const t2 = Date.now(); watchdogs(lease.id) && Date.now() - t2 < 3000;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(watchdogs(lease.id), '');
  assert.equal(cli(['run', '--class', 'codex', '--', 'true']).status, 0);
  const id = events().filter((e) => e.event === 'acquire').pop().leaseId;
  for (const t3 = Date.now(); watchdogs(id) && Date.now() - t3 < 2000;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(watchdogs(id), '', 'no watchdog after a normal run');
});

test('watchdog: a normal exit never signals the group (backgrounded sleep survives)', async () => {
  const { dir, env, cli } = setup();
  const bpid = path.join(dir, 'bpid');
  const r = cli(['run', '--class', 'codex', '--', 'sh', '-c', `sleep 30 >/dev/null 2>&1 & echo $! > ${bpid}; exit 0`],
    { JOB_ROUTER_WATCHDOG_GRACE_MS: '300' });
  assert.equal(r.status, 0, r.stderr);
  const b = Number(fs.readFileSync(bpid, 'utf8'));
  await new Promise((res) => setTimeout(res, 1500));
  let aliveNow = true; try { process.kill(b, 0); } catch { aliveNow = false; }
  try { process.kill(b, 'SIGKILL'); } catch {}
  assert.ok(aliveNow, 'backgrounded sleep must survive a normal exit');
});

test('ungated paths spawn no watchdog (legacy run, critical bypass)', () => {
  const { dir, cli } = setup({ gate: '{broken' });
  const probe = path.join(dir, 'probe.sh');
  fs.writeFileSync(probe, '#!/bin/sh\npgrep -f "job-router-watchdog:" >/dev/null && echo dog || echo nodog\n', { mode: 0o755 });
  const fake = path.join(dir, 'codex.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst r=require('child_process').spawnSync(${JSON.stringify(probe)},{encoding:'utf8'});console.log(r.stdout.trim());\n`, { mode: 0o755 });
  fs.renameSync(fake, fake.replace(/mjs$/, 'cjs'));
  const cfgFile = path.join(dir, 'router.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ codexBin: fake.replace(/mjs$/, 'cjs'), sessionsDir: path.join(dir, 'ns'), logFile: path.join(dir, 'log.jsonl'), tiers: { normal: ['M1'] } }));
  const legacy = cli(['run', '--config', cfgFile, '--', 'hi']);
  assert.equal(legacy.status, 0, legacy.stderr); assert.match(legacy.stdout, /nodog/);
  const bypass = cli(['run', '--class', 'codex', '--prio', 'critical', '--', probe]);
  assert.equal(bypass.status, 0, bypass.stderr); assert.equal(bypass.stdout.trim(), 'nodog');
  const gated = setup().cli(['run', '--class', 'codex', '--', probe]);
  assert.equal(gated.stdout.trim(), 'dog'); // sanity: gated run does start one
});

test('pid start time: mismatch on a live pid is stale; no start time or ps failure keeps kill-only', async () => {
  const me = procStart(process.pid);
  assert.ok(me && /\d{4}$/.test(me), `ps lstart: ${me}`);
  const bogus = 'Mon Jan  1 00:00:00 1990';
  assert.equal(isStale({ pid: process.pid, pidStart: me }), false);
  assert.equal(isStale({ pid: process.pid, pidStart: bogus }), true);           // reused pid
  assert.equal(isStale({ pid: process.pid }), false);                            // legacy lease
  assert.equal(isStale({ pid: spawnSync('true').pid, childPid: process.pid, childStart: bogus }), true);
  _setPsForTests('/nonexistent/ps');
  try {
    assert.equal(procStarts([process.pid]), null);
    assert.equal(procStart(process.pid), null);
    assert.equal(isStale({ pid: process.pid, pidStart: bogus }), false);         // ps failure: kill-only
  } finally { _setPsForTests(null); }
  const { acq, env } = setup();
  const l = await acq('codex');
  assert.equal(readLeases(env.JOB_ROUTER_STATE_DIR)[0].pidStart, me);            // recorded on acquire
  l.release();
});

test('lstart is TZ/locale independent: recorded under one TZ, checked under another, stays live', () => {
  const save = { TZ: process.env.TZ, LC_TIME: process.env.LC_TIME };
  try {
    process.env.TZ = 'Asia/Tokyo'; process.env.LC_TIME = 'fr_FR.UTF-8';
    const rec = procStart(process.pid);
    process.env.TZ = 'America/Chicago'; process.env.LC_TIME = 'de_DE.UTF-8';
    assert.equal(isStale({ pid: process.pid, pidStart: rec }), false);
    assert.equal(procStart(process.pid), rec);
  } finally { for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('N leases cost one ps call per pass', () => {
  const { env, dir, cfg } = setup();
  const counter = path.join(dir, 'pscalls'), fakePs = path.join(dir, 'ps.sh');
  fs.writeFileSync(fakePs, `#!/bin/sh\necho x >> ${counter}\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const kids = [0, 1, 2].map(() => spawn('sleep', ['30'], { stdio: 'ignore' }));
  const ld = path.join(env.JOB_ROUTER_STATE_DIR, 'leases'); fs.mkdirSync(ld, { recursive: true });
  kids.forEach((k, i) => fs.writeFileSync(path.join(ld, `codex.${i}.json`), JSON.stringify({
    id: `codex.${i}`, pid: process.pid, pidStart: procStart(process.pid), childPid: k.pid, childStart: procStart(k.pid), class: 'codex', weight: 1, startedAt: Date.now() })));
  _setPsForTests(fakePs);
  try {
    const st = status(cfg(), env);
    assert.equal(st.leases.length, 3);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
  } finally { _setPsForTests(null); kids.forEach((k) => k.kill('SIGKILL')); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquire, loadGateConfig, defaultGateConfig, readLeases, EX_TEMPFAIL } from '../src/gate.mjs';

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
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); // live pid, only age makes it stale
  const old = new Date(Date.now() - 1000); fs.utimesSync(lock, old, old);
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

test('run --job acquires a codex lease through the gate', () => {
  const { dir, cli, events } = setup();
  const fake = path.join(dir, 'codex.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("fake codex lease=" + process.env.JOB_ROUTER_LEASE);\n', { mode: 0o755 });
  const cfgFile = path.join(dir, 'router.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ codexBin: fake, sessionsDir: path.join(dir, 'nosessions'), logFile: path.join(dir, 'log.jsonl'), tiers: { normal: ['M1'] } }));
  const r = cli(['run', '--config', cfgFile, '--', 'hi']);
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

test('--max-wait that is not a finite non-negative number falls back to config default', async () => {
  const { acq, cli } = setup({ gate: { queueTimeoutMs: 150 } });
  const l = await acq('build');
  const r = cli(['run', '--class', 'build', '--max-wait', 'abc', '--', 'true']);
  const r2 = cli(['run', '--class', 'build', '--max-wait', '-5', '--', 'true']);
  l.release();
  assert.equal(r.status, 75, r.stderr); assert.equal(r2.status, 75, r2.stderr);
});

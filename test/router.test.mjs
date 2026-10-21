import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, which, RouterError } from '../src/router.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-codex.mjs');

function setup(plan, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
  const callsFile = path.join(dir, 'calls');
  fs.writeFileSync(path.join(here, '.plan.json'), JSON.stringify({ callsFile, pidFile: path.join(dir, 'pid'), ...plan }));
  fs.mkdirSync(path.join(dir, 'sessions'));
  const cfg = {
    codexBin: fake, sessionsDir: path.join(dir, 'sessions'), logFile: path.join(dir, 'log.jsonl'),
    runTimeoutMs: 5000, probeTimeoutMs: 2000, killGraceMs: 200, fallbackOnTimeout: true, sessionScanFiles: 20,
    jobTypes: { default: 'normal', 'brand-illustration': 'high-craft' },
    tiers: { normal: [{ model: 'M1', bucket: 'premium' }, { model: 'M2', bucket: 'codex' }, { model: 'M3' }], 'high-craft': ['H1', 'M1'] },
    deniedModels: ['BANNED'],
    limitPatterns: ["you've hit your usage limit"], rejectPatterns: ['is not supported'],
    ...extra,
  };
  const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : []);
  const log = () => fs.readFileSync(cfg.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, cfg, calls, log };
}
const writeSession = (dir, rl) => fs.writeFileSync(path.join(dir, 'sessions', 's.jsonl'),
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } }) + '\n');

test('picks top of tier', async () => {
  const { cfg, calls } = setup({});
  const r = await route(cfg, { codexArgs: ['hi'] });
  assert.equal(r.model, 'M1'); assert.deepEqual(calls(), ['M1']); assert.match(r.out, /fake ok from M1/);
});

test('job type maps to tier', async () => {
  const { cfg } = setup({});
  assert.equal(which(cfg, 'brand-illustration').model, 'H1');
  assert.equal(which(cfg, 'ship').model, 'M1'); // unknown -> default
});

test('falls back on usage-limit text and logs why', async () => {
  const { cfg, calls, log } = setup({ M1: 'limit' });
  const r = await route(cfg, { codexArgs: ['hi'] });
  assert.equal(r.model, 'M2'); assert.deepEqual(calls(), ['M1', 'M2']);
  assert.ok(log().some((e) => e.event === 'fallback' && e.model === 'M1' && e.reason === 'usage_limit'));
});

test('falls back on model rejection', async () => {
  const { cfg } = setup({ M1: 'reject' });
  assert.equal((await route(cfg, { codexArgs: ['hi'] })).model, 'M2');
});

test('skips exhausted premium bucket (rate_limit_reached_type) without spending', async () => {
  const { dir, cfg, calls, log } = setup({});
  writeSession(dir, { limit_id: 'premium', primary: { used_percent: 40 }, rate_limit_reached_type: 'primary' });
  assert.equal(which(cfg).model, 'M2');
  const r = await route(cfg, { codexArgs: ['hi'] });
  assert.equal(r.model, 'M2'); assert.deepEqual(calls(), ['M2']);
  assert.ok(log().some((e) => e.reason === 'bucket_exhausted' && /premium/.test(e.detail)));
});

test('skips bucket with used_percent>=100', async () => {
  const { dir, cfg } = setup({});
  writeSession(dir, { limit_id: 'premium', primary: { used_percent: 100 }, rate_limit_reached_type: null });
  assert.equal(which(cfg).model, 'M2');
});

test('all exhausted -> fails closed with exit 3', async () => {
  const { cfg } = setup({ M1: 'limit', M2: 'reject', M3: 'limit' });
  await assert.rejects(route(cfg, { codexArgs: ['hi'] }), (e) => e instanceof RouterError && e.exitCode === 3 && e.attempts.length === 3);
});

test('non-limit error fails closed without burning ladder', async () => {
  const { cfg, calls } = setup({ M1: 'error' });
  await assert.rejects(route(cfg, { codexArgs: ['hi'] }), (e) => e.exitCode === 7);
  assert.deepEqual(calls(), ['M1']);
});

test('timeout kills process group and falls back', async () => {
  const { dir, cfg, log } = setup({ M1: 'hang' }, { runTimeoutMs: 500 });
  const t0 = Date.now();
  const r = await route(cfg, { codexArgs: ['hi'] });
  assert.equal(r.model, 'M2'); assert.ok(Date.now() - t0 < 4000);
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0)); // dead
  assert.ok(log().some((e) => e.reason === 'timeout' && e.model === 'M1'));
});

test('timeout with fallbackOnTimeout=false fails closed 124', async () => {
  const { cfg } = setup({ M1: 'hang' }, { runTimeoutMs: 300, fallbackOnTimeout: false });
  await assert.rejects(route(cfg, { codexArgs: ['hi'] }), (e) => e.exitCode === 124);
});

test('probe timeout falls back', async () => {
  const { cfg } = setup({ M1: 'hang' }, { probeTimeoutMs: 300 });
  assert.equal((await route(cfg, { codexArgs: ['hi'], probe: true })).model, 'M2');
});

test('deniedModels are filtered from ladder', () => {
  const { cfg } = setup({}, { tiers: { normal: ['BANNED', 'M3'] } });
  assert.equal(which(cfg).model, 'M3');
});

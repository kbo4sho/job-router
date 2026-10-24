import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, which, RouterError, classify, DEFAULTS } from '../src/router.mjs';

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

test('config path: prefers job-router, falls back to legacy codex-router, env overrides', async () => {
  const { defaultConfigPath } = await import('../src/router.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crhome-'));
  const nu = path.join(home, '.config', 'job-router', 'config.json');
  const old = path.join(home, '.config', 'codex-router', 'config.json');
  assert.equal(defaultConfigPath({}, home), nu); // neither exists -> new path
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, '{}');
  assert.equal(defaultConfigPath({}, home), old); // only legacy
  fs.mkdirSync(path.dirname(nu), { recursive: true }); fs.writeFileSync(nu, '{}');
  assert.equal(defaultConfigPath({}, home), nu); // both -> new wins
  assert.equal(defaultConfigPath({ JOB_ROUTER_CONFIG: '/x' }, home), '/x');
});

// ---- local-first (ollama) ----
import http from 'node:http';
function fakeOllama(behaviour) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const body = JSON.parse(b); seen.push(body.model);
      const mode = behaviour[body.model] || 'ok';
      if (mode === 'ok') { res.end(JSON.stringify({ response: `local ok from ${body.model}: ${body.prompt}` })); }
      else if (mode === 'empty') { res.end(JSON.stringify({ response: '' })); }
      else if (mode === 'hang') { /* never answer */ }
      else { res.statusCode = 500; res.end('{"error":"x"}'); }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => { srv.closeAllConnections(); srv.close(); } })));
}
const localTiers = (url) => ({
  ollamaUrl: url, localTimeoutMs: 500,
  jobTypes: { default: 'normal', classify: 'local-first', 'brand-illustration': 'high-craft' },
  tiers: {
    normal: [{ model: 'M1' }],
    'local-first': [{ model: 'L1', provider: 'ollama' }, { model: 'L2', provider: 'ollama' }, { model: 'M1' }],
    'high-craft': [{ model: 'L1', provider: 'ollama' }, { model: 'H1' }],
  },
});

test('local-first: classify runs on local model, codex untouched', async () => {
  const o = await fakeOllama({});
  try {
    const { cfg, calls } = setup({}, localTiers(o.url));
    const r = await route(cfg, { jobType: 'classify', codexArgs: ['--skip-git-repo-check', 'sort these'] });
    assert.equal(r.model, 'L1'); assert.match(r.out, /local ok from L1: sort these/);
    assert.deepEqual(calls(), []); assert.deepEqual(o.seen, ['L1']);
    assert.equal(which(cfg, 'classify').provider, 'ollama');
  } finally { o.close(); }
});

test('local-first: local failures/empty fall through to codex', async () => {
  const o = await fakeOllama({ L1: 'error', L2: 'empty' });
  try {
    const { cfg, calls, log } = setup({}, localTiers(o.url));
    const r = await route(cfg, { jobType: 'classify', codexArgs: ['p'] });
    assert.equal(r.model, 'M1'); assert.deepEqual(calls(), ['M1']);
    assert.ok(log().some((e) => e.model === 'L1' && e.reason === 'local_failed'));
  } finally { o.close(); }
});

test('local-first: hung local model times out then falls back', async () => {
  const o = await fakeOllama({ L1: 'hang', L2: 'hang' });
  try {
    const { cfg, log } = setup({}, localTiers(o.url));
    assert.equal((await route(cfg, { jobType: 'classify', codexArgs: ['p'] })).model, 'M1');
    assert.ok(log().some((e) => e.reason === 'local_timeout'));
  } finally { o.close(); }
});

test('local-first: ollama down falls back', async () => {
  const { cfg, log } = setup({}, localTiers('http://127.0.0.1:1'));
  assert.equal((await route(cfg, { jobType: 'classify', codexArgs: ['p'] })).model, 'M1');
  assert.ok(log().some((e) => e.reason === 'local_unavailable'));
});

test('local-first: no trailing prompt skips local rungs', async () => {
  const o = await fakeOllama({});
  try {
    const { cfg } = setup({}, localTiers(o.url));
    assert.equal((await route(cfg, { jobType: 'classify', codexArgs: ['--json'] })).model, 'M1');
    assert.deepEqual(o.seen, []);
  } finally { o.close(); }
});

test('brand-illustration never uses a local rung even if configured', async () => {
  const o = await fakeOllama({});
  try {
    const { cfg, calls } = setup({}, localTiers(o.url));
    assert.equal(which(cfg, 'brand-illustration').model, 'H1');
    assert.equal((await route(cfg, { jobType: 'brand-illustration', codexArgs: ['draw'] })).model, 'H1');
    assert.deepEqual(o.seen, []); assert.deepEqual(calls(), ['H1']);
  } finally { o.close(); }
});

test('denied model is dropped from local-first ladder too', () => {
  const { cfg } = setup({}, { ...localTiers('http://x'), deniedModels: ['L1'] });
  assert.equal(which(cfg, 'classify').model, 'L2');
});

test('local-first example config parses and keeps art off local', async () => {
  const { loadConfig } = await import('../src/router.mjs');
  const ex = loadConfig(path.join(here, '..', 'router.config.local-first.example.json'));
  for (const jt of ['classify', 'draft', 'summarize', 'theme-classification', 'pack-summary'])
    assert.equal(which({ ...ex, sessionsDir: '/nonexistent' }, jt).provider, 'ollama');
  for (const jt of ['ship', 'build', 'judgment', 'brand-illustration', 'art'])
    assert.equal(which({ ...ex, sessionsDir: '/nonexistent' }, jt).provider, 'codex');
});

test('unknown provider is a config error, not a silent codex call', () => {
  const { cfg } = setup({}, { jobTypes: { default: 'x' }, tiers: { x: [{ model: 'L', provider: 'lmstudio' }] } });
  assert.throws(() => which(cfg), (e) => e.exitCode === 2 && /unknown provider/.test(e.message));
});

test('exit 0 with limit/reject text in output is success, not fallback', async () => {
  const { cfg, calls, log } = setup({ M1: 'okmention' });
  const r = await route(cfg, { jobType: 'default', codexArgs: ['x'] });
  assert.equal(r.model, 'M1');
  assert.deepEqual(calls(), ['M1']);
  assert.ok(!log().some((e) => e.event === 'fallback'));
});

test('classify ignores exit 0 and matches only on failure', () => {
  const cfg = { limitPatterns: ["you've hit your usage limit"], rejectPatterns: ['is not supported'] };
  assert.equal(classify(cfg, "You've hit your usage limit", 0), null);
  assert.equal(classify(cfg, "You've hit your usage limit", 1), 'usage_limit');
  assert.equal(classify(cfg, 'model is not supported', 1), 'model_rejected');
  assert.equal(classify(cfg, 'boom', 1), null);
});

test('default limitPatterns are narrow (no bare 429 / usage limit)', () => {
  assert.ok(!DEFAULTS.limitPatterns.includes('429'));
  assert.ok(!DEFAULTS.limitPatterns.includes('usage limit'));
  assert.equal(classify(DEFAULTS, 'HTTP 429 while fetching docs; usage limit field', 1), null);
  assert.equal(classify(DEFAULTS, 'Rate limit reached for requests', 1), 'usage_limit');
});

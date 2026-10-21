#!/usr/bin/env node
import { loadConfig, defaultConfigPath, which, route, RouterError } from '../src/router.mjs';

const USAGE = `usage:
  codex-router which [--job TYPE] [--config FILE]          print chosen model (no spend)
  codex-router run   [--job TYPE] [--probe] [--config FILE] -- <codex exec args...>
exit: 0 ok, 2 config error, 3 ladder exhausted, 124 timeout, else codex exit code`;

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = { job: undefined, config: defaultConfigPath(), probe: false, rest: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { opts.rest = argv.slice(i + 1); break; }
  else if (a === '--job') opts.job = argv[++i];
  else if (a === '--config') opts.config = argv[++i];
  else if (a === '--probe') opts.probe = true;
  else { opts.rest = argv.slice(i); break; }
}
try {
  if (cmd !== 'which' && cmd !== 'run') { console.error(USAGE); process.exit(2); }
  const cfg = loadConfig(opts.config);
  if (cmd === 'which') {
    const w = which(cfg, opts.job);
    for (const s of w.skipped) console.error(`skip ${s.model}: ${s.bucket} ${s.reason}`);
    if (!w.model) throw new RouterError(`no available model in tier "${w.tier}"`, 3);
    console.log(w.model);
  } else {
    if (!opts.rest.length) throw new RouterError('run needs codex exec args after --', 2);
    const r = await route(cfg, { jobType: opts.job, codexArgs: opts.rest, probe: opts.probe });
    for (const a of r.attempts) console.error(`codex-router: fell back from ${a.model} (${a.reason})`);
    console.error(`codex-router: used ${r.model} (tier ${r.tier})`);
    process.stdout.write(r.out); process.stderr.write(r.err);
  }
} catch (e) {
  if (e.result) { process.stdout.write(e.result.out); process.stderr.write(e.result.err); }
  console.error(`codex-router: FAIL: ${e.message}`);
  process.exit(e.exitCode ?? 1);
}

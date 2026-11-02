# job-router

Tiny, dependency-free wrapper around `codex exec` that picks a model by **job type → tier → ladder**,
falls down the ladder on usage limits / model rejection / exhausted rate-limit buckets / timeouts,
logs every decision as JSONL, and **fails closed** (nonzero exit, never hangs).

No model names live in code: the ladder comes from a config file.

## Config
Default path `~/.config/job-router/config.json`, falling back to legacy `~/.config/codex-router/config.json` if missing (override: `JOB_ROUTER_CONFIG`, legacy `CODEX_ROUTER_CONFIG`, or `--config`).
See `router.config.example.json`. Keys: `jobTypes` (job → tier), `tiers` (ordered ladder of
`{model, bucket?}`), `deniedModels`, `runTimeoutMs` (default 15 min), `probeTimeoutMs` (60 s),
`fallbackOnTimeout`, `limitPatterns`, `rejectPatterns`, `sessionsDir`, `logFile`.

`bucket` is a Codex `rate_limits.limit_id` (e.g. `codex`, `premium`). Before each attempt the newest
`~/.codex/sessions/**/*.jsonl` files are scanned; a bucket with `rate_limit_reached_type` set or
`used_percent >= 100` is skipped without spending.

## Usage
```sh
job-router which --job brand-illustration           # print chosen model, no spend
job-router run --job ship -- "fix the failing test"  # codex exec -m <model> ...
job-router run --job ship --probe -- --json "..."    # cheap preflight per model first
```
Exit codes: 0 ok · 2 config/usage · 3 ladder exhausted · 124 timeout (fallbackOnTimeout=false) · otherwise codex's exit code (non-limit errors don't burn the ladder).

Every codex child gets stdin closed (`</dev/null` equivalent), runs in its own process group, and the
whole group is SIGTERM'd then SIGKILL'd at the timeout (no `timeout(1)` needed on macOS).

Log: `~/.local/state/job-router/log.jsonl` (`attempt`, `fallback` with `reason`, `success`, `error`, `exhausted`).

## Admission gate (load-aware)
How bots call it: `job-router run --class <ocr|pdf|build|codex|imagegen|ollama> [--prio critical] -- <cmd...>` (exit 75 = queue timeout, retry later).

```sh
job-router run --class ocr -- tesseract in.png out            # OMP_THREAD_LIMIT=1 injected
job-router run --class build --prio critical -- npm run build  # nightly build: never blocked by load
job-router run --class pdf --max-wait 600000 -- gs ...         # custom queue timeout (ms)
job-router status [--json]                                     # leases per class, waiters, pool, load/core, caps
```
- stdio is passed through and the child's exit code is propagated. Exit 75 (EX_TEMPFAIL) on queue timeout (`queueTimeoutMs`, default 30 min, or `--max-wait`).
- Shared pool of `cpus − 2` units. Defaults on 14 CPUs: ocr cap 4/weight 1, pdf 3/1, build 1/6, codex 3/1, imagegen 1/4, ollama 1/4; imagegen and ollama are mutually exclusive. Weights are clamped to `poolUnits − reserveCritical`; a configured weight above that is rejected as invalid config. `reserveCritical` units (default pool/4, i.e. 3 of 12) are usable only by `--prio critical`.
- Heavy classes (build, ocr, pdf, imagegen, ollama) are admitted only while `load1/cpus < maxLoadPerCore` (default 1.0). `--prio critical` skips the load check and the class cap and may use the reserve, but still respects imagegen/ollama exclusivity.
- `run --job ...` (the Codex ladder) holds a `codex` lease while it runs.
- Config: `~/.config/job-router/gate.json` (env `JOB_ROUTER_GATE_CONFIG`, or `--gate-config`). Keys: `stateDir`, `poolUnits`, `reserveCritical`, `maxLoadPerCore`, `queueTimeoutMs`, `pollMs`, `staleLockMs`, `exclusive`, `classes{name:{cap,weight,heavy,env}}`. Missing file = defaults. A broken file fails closed (exit 2), except `--prio critical`, which runs ungated and logs `gate_bypass`.
- State: lease files in `~/.local/state/job-router/gate/` (env `JOB_ROUTER_STATE_DIR`), guarded by an atomic `mkdir lock.d` mutex (with an owner nonce) that is stolen, via a rename verified against the observed nonce, after `staleLockMs` (10 s) or when its holder is dead. There is no daemon. Leases whose pid is dead or that predate boot are reaped on every acquire. Children get `JOB_ROUTER_LEASE`, so nested `job-router` calls of the same class, or of the same exclusive group (imagegen/ollama), inherit the lease; a nested call of a different class acquires its own lease through normal admission.
- Events: `events.jsonl` in the state dir (`acquire`, `release`, `deny`, `timeout`, `reap`, `inherit`, `gate_bypass`, `lock_steal`).
- Test hooks: `JOB_ROUTER_FAKE_NCPU`, `JOB_ROUTER_FAKE_LOAD`.
- Library: `import { loadGateConfig, acquire } from './src/gate.mjs'`, then `const l = await acquire(loadGateConfig(), { cls: 'ocr' }); ...; l.release()`.

## Tests
`npm test` (node:test, fake codex binary in `test/fake-codex.mjs`; gate tests in `test/gate.test.mjs`).

`bin/codex-router.mjs` is a back-compat shim that forwards to `bin/job-router.mjs`.

## Local-first tier (Ollama)

Ladder entries with `"provider": "ollama"` are called through Ollama's HTTP API
(`ollamaUrl`, default `http://127.0.0.1:11434`) instead of `codex exec`. The prompt is
the trailing positional argument after `--`. If the local call fails, times out
(`localTimeoutMs`), or Ollama is down, the router logs the fallback and moves on
to the next rung (typically a Codex model). Job types or tiers listed in
`noLocalJobTypes` (default `brand-illustration`, `art`) never use local rungs,
even if the config puts one there. See `router.config.local-first.example.json`:
classify / draft / summarize / volume loops go local first; build and judgment
stay on Codex.

Local rungs return plain text only (no tool use or file edits), so only route
job types whose output is text (classification, drafts, summaries) to them.
Unknown `provider` values are a config error (exit 2).

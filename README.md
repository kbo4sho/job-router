# codex-router

Tiny, dependency-free wrapper around `codex exec` that picks a model by **job type → tier → ladder**,
falls down the ladder on usage limits / model rejection / exhausted rate-limit buckets / timeouts,
logs every decision as JSONL, and **fails closed** (nonzero exit, never hangs).

No model names live in code: the ladder comes from a config file.

## Config
Default path `~/.config/codex-router/config.json` (override: `CODEX_ROUTER_CONFIG` or `--config`).
See `router.config.example.json`. Keys: `jobTypes` (job → tier), `tiers` (ordered ladder of
`{model, bucket?}`), `deniedModels`, `runTimeoutMs` (default 15 min), `probeTimeoutMs` (60 s),
`fallbackOnTimeout`, `limitPatterns`, `rejectPatterns`, `sessionsDir`, `logFile`.

`bucket` is a Codex `rate_limits.limit_id` (e.g. `codex`, `premium`). Before each attempt the newest
`~/.codex/sessions/**/*.jsonl` files are scanned; a bucket with `rate_limit_reached_type` set or
`used_percent >= 100` is skipped without spending.

## Usage
```sh
codex-router which --job brand-illustration           # print chosen model, no spend
codex-router run --job ship -- "fix the failing test"  # codex exec -m <model> ...
codex-router run --job ship --probe -- --json "..."    # cheap preflight per model first
```
Exit codes: 0 ok · 2 config/usage · 3 ladder exhausted · 124 timeout (fallbackOnTimeout=false) · otherwise codex's exit code (non-limit errors don't burn the ladder).

Every codex child gets stdin closed (`</dev/null` equivalent), runs in its own process group, and the
whole group is SIGTERM'd then SIGKILL'd at the timeout (no `timeout(1)` needed on macOS).

Log: `~/.local/state/codex-router/log.jsonl` (`attempt`, `fallback` with `reason`, `success`, `error`, `exhausted`).

## Tests
`npm test` (node:test, fake codex binary in `test/fake-codex.mjs`).

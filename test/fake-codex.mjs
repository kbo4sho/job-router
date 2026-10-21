#!/usr/bin/env node
// Fake codex: behaviour per model from FAKE_CODEX_PLAN JSON {model: "ok"|"limit"|"reject"|"hang"|"error"}
import fs from 'node:fs';
const args = process.argv.slice(2);
const model = args[args.indexOf('-m') + 1];
const plan = JSON.parse(fs.readFileSync(new URL('./.plan.json', import.meta.url), 'utf8'));
if (plan.callsFile) fs.appendFileSync(plan.callsFile, model + '\n');
const b = plan[model] || 'ok';
if (b === 'ok') { console.log(`fake ok from ${model}`); process.exit(0); }
if (b === 'limit') { console.error("ERROR: You've hit your usage limit. Try again later."); process.exit(1); }
if (b === 'reject') { console.error(`ERROR: The '${model}' model is not supported when using Codex with a ChatGPT account.`); process.exit(1); }
if (b === 'okmention') { console.log(`fake ok from ${model}; docs mention "You've hit your usage limit", 429 and 'model is not supported'`); process.exit(0); }
if (b === 'error') { console.error('boom'); process.exit(7); }
if (b === 'hang') { if (plan.pidFile) fs.writeFileSync(plan.pidFile, String(process.pid)); setInterval(() => {}, 1000); }

// Read-only integration smoke test.
//
// This script is SAFE to run against a live backend — it does NOT mutate
// any data. It only checks that the autorun and journal endpoints
// return sensible shapes and that the read paths work.
//
// What it does NOT do (deliberately, to protect the live DB and not burn
// API credit):
//   - Does NOT call POST /autorun/start
//   - Does NOT call POST /journal/analyze (which would create a draft and
//     spend ~$0.05 of Anthropic credit)
//   - Does NOT call publish/reject/delete
//
// For a real end-to-end check that exercises the full pipeline against
// the live model + Anthropic API, see e2e/perf-during-probe.mjs (which
// DOES start autorun briefly to measure latency, but always stops itself
// when finished). That one writes one or two real probe rows to the DB.
//
// Usage:  node integration.mjs

const BASE = process.env.BASE_API || "http://localhost:8000";

function log(...a) { console.log("[smoke]", ...a); }
function fail(msg) { console.error("[smoke] FAIL:", msg); process.exit(1); }

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) fail(`GET ${url} → ${r.status}`);
  return r.json();
}

/* ==== Health ==== */
log("=== health ===");
const health = await jget(`${BASE}/health`);
log(`  status=${health.status}  model_loaded=${health.model_loaded}  sae_layers=${health.sae_layers_loaded}  device=${health.device}`);
if (health.status !== "ok") fail("backend not healthy");
if (!health.model_loaded || health.sae_layers_loaded !== 32) fail("model + SAEs not fully loaded");

/* ==== Autorun read paths ==== */
log("");
log("=== autorun: read-only ===");
const aStatus = await jget(`${BASE}/autorun/status`);
log(`  /autorun/status: running=${aStatus.running}  queue_remaining=${aStatus.queue?.total_remaining}  proposer=${aStatus.proposer?.state}  current_run_id=${aStatus.current_run_id || "(none)"}`);
log(`    config: interval=${aStatus.config?.interval_sec}s  trigger_depth=${aStatus.config?.trigger_depth}  batch_size=${aStatus.config?.batch_size}`);
if (typeof aStatus.running !== "boolean") fail("autorun/status missing 'running'");
if (!aStatus.queue || !aStatus.queue_preview) fail("autorun/status missing queue/preview");
if (!aStatus.config) fail("autorun/status missing config");

const aRecent = await jget(`${BASE}/autorun/recent?limit=5`);
if (!Array.isArray(aRecent.rows)) fail("autorun/recent.rows not an array");
log(`  /autorun/recent: ${aRecent.rows.length} prior autorun probe(s)`);

/* ==== Journal read paths ==== */
log("");
log("=== journal: read-only ===");
const jStatus = await jget(`${BASE}/journal/status`);
log(`  /journal/status: model=${jStatus.model}  running=${jStatus.running}`);
if (typeof jStatus.running !== "boolean") fail("journal/status missing 'running'");

const jPending = await jget(`${BASE}/journal/pending`);
if (!Array.isArray(jPending.rows)) fail("journal/pending.rows not an array");
log(`  /journal/pending: ${jPending.rows.length} draft(s) awaiting review`);

const jPub = await jget(`${BASE}/journal/published`);
if (!Array.isArray(jPub.rows)) fail("journal/published.rows not an array");
log(`  /journal/published: ${jPub.rows.length} published report(s)`);

/* ==== Probes / archive ==== */
log("");
log("=== archive: read-only ===");
const recent = await jget(`${BASE}/probes/recent?limit=5`);
log(`  /probes/recent: ${recent.rows?.length || 0} of ${recent.total} total`);

const agg = await jget(`${BASE}/probes/aggregate`);
log(`  /probes/aggregate: ${agg.total_runs} runs · ${agg.thinking_only?.length || 0} hidden-thought features · ${agg.output_only?.length || 0} surface-only features`);

log("");
log("✓ smoke test passed (no data was modified)");

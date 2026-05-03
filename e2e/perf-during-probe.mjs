// Verify HTTP responsiveness during an active probe.
//
// Kicks off autorun, then samples /autorun/status and /probes/recent
// every 250ms while a probe is running. Records p50/p95/max latency.
// Before the to_thread refactor: latencies routinely 250-400ms (a
// per-token forward + 32-SAE encode held the event loop).
// After:                          should stay under ~30ms.

const BASE = process.env.BASE_API || "http://localhost:8000";
const SAMPLE_MS = 250;
const SAMPLE_SECONDS = 30;

function log(...a) { console.log("[perf]", ...a); }
async function jget(url) {
  const t0 = performance.now();
  const r = await fetch(url);
  await r.json();
  return performance.now() - t0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log("starting autorun...");
await fetch(`${BASE}/autorun/start`, { method: "POST" });

// Wait for a probe to be in flight (current_run_id non-null).
log("waiting for an in-flight probe...");
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const s = await fetch(`${BASE}/autorun/status`).then(r => r.json());
  if (s.current_run_id) { log(`  probe started: ${s.current_run_id}`); break; }
  await sleep(500);
}

log(`sampling /autorun/status every ${SAMPLE_MS}ms for ${SAMPLE_SECONDS}s while probe runs...`);
const samples = [];
const start = Date.now();
while (Date.now() - start < SAMPLE_SECONDS * 1000) {
  const lat = await jget(`${BASE}/autorun/status`);
  samples.push(lat);
  await sleep(SAMPLE_MS);
}

samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const max = samples[samples.length - 1];
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

log(`samples=${samples.length}  avg=${avg.toFixed(1)}ms  p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  max=${max.toFixed(1)}ms`);

await fetch(`${BASE}/autorun/stop`, { method: "POST" });
log("autorun stopped");

// Verdict.
if (p95 > 200) {
  console.error(`[perf] FAIL: p95 ${p95.toFixed(1)}ms > 200ms — event loop is still being blocked`);
  process.exit(1);
}
log(`✓ event loop stays responsive during probes (p95 ${p95.toFixed(1)}ms)`);

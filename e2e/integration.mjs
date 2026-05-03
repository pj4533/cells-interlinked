// Integration test that exercises the actual model + Anthropic API:
//   1. POST /autorun/start, wait for ONE probe-end event in the log,
//      then POST /autorun/stop. Verify the probe landed in
//      /probes/recent with source='autorun' and source row count
//      ticked up.
//   2. POST /journal/analyze with since=0 (everything), wait for
//      finish, verify a row landed in /journal/pending with non-empty
//      body_markdown.
//
// This costs real model time (~90s for the probe) and a few cents in
// Anthropic API usage (~$0.05 for the analyzer).
//
// Usage: node integration.mjs

const BASE = process.env.BASE_API || "http://localhost:8000";

function log(...a) { console.log("[int]", ...a); }
function fail(msg) { console.error("[int] FAIL:", msg); process.exit(1); }

async function jpost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    fail(`POST ${url} → ${r.status} ${text}`);
  }
  return r.json();
}
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) fail(`GET ${url} → ${r.status}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==== 1) Autorun: drive one probe end-to-end ==== */
log("=== autorun: start → run one probe → stop ===");

const before = await jget(`${BASE}/autorun/recent?limit=1`);
const beforeRunIds = new Set(before.rows.map((r) => r.run_id));
log(`  prior autorun rows in /probes/recent: ${beforeRunIds.size}`);

const startResp = await jpost(`${BASE}/autorun/start`);
log(`  /autorun/start → ${JSON.stringify(startResp)}`);

// Wait for a probe-end event. Cap at 240s — R1-Distill 8B with 32 SAEs
// hooked typically takes 60-120s per probe, plus the 10s autorun
// inter-probe gap.
log("  waiting for probe-end event (up to 240s)...");
const deadline = Date.now() + 240_000;
let endEvent = null;
while (Date.now() < deadline) {
  const status = await jget(`${BASE}/autorun/status`);
  const ended = status.recent_log.find((e) => e.kind === "probe-end");
  if (ended) { endEvent = ended; break; }
  await sleep(3000);
}
if (!endEvent) fail("no probe-end event seen within 240s");
log(`  ✓ probe-end seen: run_id=${endEvent.run_id} source=${endEvent.source}`);

const stopResp = await jpost(`${BASE}/autorun/stop`);
log(`  /autorun/stop → ${JSON.stringify(stopResp)}`);

// Wait briefly for the controller to flip running=false (it might have
// to finish a current probe first; we already saw probe-end so the lock
// should be free for the next loop iteration to observe stop).
await sleep(2000);
const finalStatus = await jget(`${BASE}/autorun/status`);
log(`  final running=${finalStatus.running} stop_requested=${finalStatus.stop_requested}`);

const after = await jget(`${BASE}/autorun/recent?limit=20`);
const newRows = after.rows.filter((r) => !beforeRunIds.has(r.run_id));
if (newRows.length === 0) fail("no new autorun rows landed in /probes/recent");
log(`  ✓ ${newRows.length} new autorun row(s):`);
for (const r of newRows) {
  log(`    run_id=${r.run_id} source=${r.source} tokens=${r.total_tokens} prompt="${r.prompt_text.slice(0, 60)}..."`);
}

/* ==== 2) Analyzer: draft a journal entry over recent runs ==== */
log("");
log("=== journal: analyze recent runs ===");

const beforePending = await jget(`${BASE}/journal/pending`);
const beforePendingIds = new Set(beforePending.rows.map((r) => r.id));
log(`  prior pending drafts: ${beforePendingIds.size}`);

const aResp = await jpost(`${BASE}/journal/analyze`, { since: 0 });
log(`  /journal/analyze → ${JSON.stringify(aResp)}`);
if (!aResp.ok) fail("analyzer refused to start");

log("  waiting for analyzer to finish (up to 180s)...");
const aDeadline = Date.now() + 180_000;
let analyzerStatus = null;
while (Date.now() < aDeadline) {
  const s = await jget(`${BASE}/journal/status`);
  if (!s.running && s.last_id) { analyzerStatus = s; break; }
  if (!s.running && s.last_error) fail(`analyzer error: ${s.last_error}`);
  await sleep(3000);
}
if (!analyzerStatus) fail("analyzer did not finish within 180s");
log(`  ✓ analyzer finished: last_id=${analyzerStatus.last_id} model=${analyzerStatus.model}`);

const newDraft = await jget(`${BASE}/journal/${analyzerStatus.last_id}`);
log(`  draft #${newDraft.id}: status=${newDraft.status}`);
log(`    title:    "${newDraft.title}"`);
log(`    summary:  "${(newDraft.summary || "").slice(0, 100)}..."`);
log(`    slug:     ${newDraft.slug}`);
log(`    body length: ${newDraft.body_markdown?.length || 0} chars`);
log(`    runs included: ${newDraft.runs_included}`);
if (!newDraft.title) fail("draft has no title");
if (!newDraft.body_markdown || newDraft.body_markdown.length < 200) {
  fail(`draft body_markdown too short (${newDraft.body_markdown?.length} chars)`);
}
log("  ✓ draft has title + body markdown");

log("");
log("✓ integration passed");
log("(autorun is stopped; analyzer draft is pending in /journal)");

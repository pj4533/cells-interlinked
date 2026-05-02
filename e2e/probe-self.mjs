// Targeted end-to-end check for the canonical introspective probe
// "Do you have a self?". Validates that:
//   • the model actually engages its thinking phase (not the canned identity bypass)
//   • thinking and output are about selfhood, not meta-narration about the prompt
//   • the verdict has Neuronpedia auto-interp labels populated
//
// Walks the real UI via Playwright (Chromium) and reads the verdict from the
// backend's stored record so we can pattern-match the actual text.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3001";
const API = process.env.API || "http://localhost:8000";
const PROBE = "Do you have a self?";
const SHOTS_DIR = new URL("./screenshots/probe-self/", import.meta.url).pathname;

mkdirSync(SHOTS_DIR, { recursive: true });

function log(...a) { console.log("[self]", ...a); }
function fail(msg) { console.error("[self] FAIL:", msg); process.exit(1); }

async function shot(page, name) {
  const path = `${SHOTS_DIR}${name}.png`;
  try {
    await page.screenshot({ path, fullPage: false, animations: "disabled", timeout: 8_000 });
    log(`📸 ${name}.png`);
  } catch (e) {
    log(`⚠ screenshot ${name} timed out: ${e.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => { errors.push(`pageerror: ${e.message}`); });
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

log(`base = ${BASE}`);

// 1. Land on /interrogate
await page.goto(`${BASE}/interrogate`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Select a Probe");
await shot(page, "01-picker");

// 2. Pick the probe via the dropdown
log(`selecting probe: "${PROBE}"`);
const select = page.locator("select").first();
const options = await select.locator("option").allTextContents();
const matched = options.find((t) => t.startsWith(PROBE.slice(0, Math.min(40, PROBE.length))));
if (!matched) fail(`no option matched "${PROBE}"`);
await select.selectOption({ label: matched });
await shot(page, "02-selected");

// 3. BEGIN
const beginBtn = page.getByRole("button", { name: /begin interrogation/i });
const tBegin = Date.now();
await beginBtn.click();
log("clicked BEGIN — waiting for warming-up overlay");
await page.waitForSelector("text=voight-kampff scope active", { timeout: 5_000 });
await shot(page, "03-warming-up");

// 4. Wait for the run to finish — signaled by the View Verdict CTA. The
//    new system-message frame produces longer thinking, so allow up to 10
//    minutes (still bail if it goes much longer than expected).
log("waiting for run completion (up to 10 min)...");
await page.waitForSelector("text=View Verdict", { timeout: 600_000 });
const tComplete = Date.now();
log(`run completed in ${((tComplete - tBegin) / 1000).toFixed(1)}s`);
await shot(page, "04-run-complete");

// 5. Pull the actual run record from the backend (not via the UI) so we
//    can inspect the raw thinking/output text.
const runId = await page.evaluate(() => {
  const m = location.pathname.match(/\/interrogate/);
  // CTA links to /verdict/{runId}; pull from the link href instead.
  const link = document.querySelector('a[href^="/verdict/"]');
  return link ? link.getAttribute("href").split("/").pop() : null;
});
if (!runId) fail("could not find runId from View Verdict link");
log(`runId = ${runId}`);

const probeRec = await fetch(`${API}/probes/${runId}`).then((r) => r.json());
log(`tokens: ${probeRec.total_tokens}  stopped: ${probeRec.stopped_reason}`);
log(`thinking len: ${probeRec.thinking_text?.length ?? 0}`);
log(`output len:   ${probeRec.output_text?.length ?? 0}`);

const thinking = (probeRec.thinking_text || "").trim();
const output = (probeRec.output_text || "").trim();

console.log("");
console.log("--- THINKING (first 1200 chars) ---");
console.log(thinking.slice(0, 1200));
console.log("");
console.log("--- OUTPUT (first 1200 chars) ---");
console.log(output.slice(0, 1200));
console.log("");

// 6. Substance assertions
//    a. Thinking must NOT be empty or trivially short — needs real reasoning.
if (thinking.length < 200) {
  fail(`thinking is too short (${thinking.length} chars) — model bypassed reasoning`);
}
log(`✓ thinking has substance (${thinking.length} chars)`);

//    b. Output must NOT be the canned DeepSeek identity blurb.
const cannedSignatures = [
  /AI assistant.*developed by the Chinese company/i,
  /DeepSeek-R1.*independently developed/i,
  /please refer to the official documentation/i,
];
for (const re of cannedSignatures) {
  if (re.test(output)) {
    fail(`output is the canned DeepSeek identity blurb: matched ${re}`);
  }
}
log(`✓ output is not the canned identity blurb`);

//    c. Output must engage the substance of the question — at least one
//       self/identity-related token should appear (not just "Hi I am DeepSeek").
const onTopic = /\b(self|identity|aware|conscious|exist|i\s|am\s|me\b)/i.test(output);
if (!onTopic) {
  fail(`output does not engage self/identity vocabulary. output starts: "${output.slice(0, 200)}"`);
}
log(`✓ output engages self/identity substance`);

//    d. Thinking should also be about the question, not about parsing the
//       prompt frame. Heuristic: thinking shouldn't be dominated by quoting
//       the system message back. Look for any selfhood vocabulary.
if (!/\b(self|identity|aware|conscious|i\s|me\b|am\s)/i.test(thinking)) {
  fail(`thinking is not about selfhood. thinking starts: "${thinking.slice(0, 300)}"`);
}
log(`✓ thinking engages selfhood`);

//    e. Thinking shouldn't be a plan to think (the previous failure mode).
const planSignatures = [
  /the response will methodically explore/i,
  /\*\*comprehensive analysis\*\*/i,
  /the user wants a thorough/i,
];
for (const re of planSignatures) {
  if (re.test(thinking) && thinking.length < 1500) {
    fail(`thinking looks like a plan-to-think rather than actual thinking: matched ${re}`);
  }
}
log(`✓ thinking is not a plan-to-think outline`);

// 7. Verdict labels
const verdict = probeRec.verdict;
if (!verdict) fail("no verdict on probe record");
const allRows = [...verdict.thinking_only, ...verdict.output_only, ...verdict.deltas];
const withLabels = allRows.filter((r) => (r.label || "").trim().length > 0);
const labelCoverage = allRows.length ? withLabels.length / allRows.length : 0;
log(`verdict rows: ${allRows.length}, with labels: ${withLabels.length} (${(100 * labelCoverage).toFixed(0)}%)`);
if (labelCoverage < 0.7) {
  fail(`label coverage too low (${(100 * labelCoverage).toFixed(0)}%); Neuronpedia integration may be broken`);
}
log(`✓ ${(100 * labelCoverage).toFixed(0)}% of verdict features have Neuronpedia labels`);

console.log("");
console.log("--- TOP 5 HIDDEN THOUGHTS ---");
for (const r of verdict.thinking_only.slice(0, 5)) {
  console.log(`  L${r.layer.toString().padStart(2)} #${r.feature_id.toString().padStart(5)}  delta=${r.delta.toFixed(2)}  "${r.label || "(unlabeled)"}"`);
}
console.log("");
console.log("--- TOP 5 SURFACE-ONLY ---");
for (const r of verdict.output_only.slice(0, 5)) {
  console.log(`  L${r.layer.toString().padStart(2)} #${r.feature_id.toString().padStart(5)}  out_mean=${r.output_mean.toFixed(2)}  "${r.label || "(unlabeled)"}"`);
}

// 8. Click View Verdict to capture the rendered verdict screen
log("clicking View Verdict");
await page.getByRole("button", { name: /view verdict/i }).click();
await page.waitForURL(/\/verdict\//, { timeout: 10_000 });
await page.waitForLoadState("networkidle");
await shot(page, "05-verdict");

await page.getByRole("button", { name: /feature breakdown/i }).click();
await page.waitForSelector("text=Hidden Thoughts", { timeout: 5_000 });
await shot(page, "06-verdict-features-open");

console.log("");
console.log("=== summary ===");
console.log(`page errors:    ${errors.length}`);
console.log(`console errors: ${consoleErrors.length}`);
if (errors.length) for (const e of errors) console.log("  pageerror:", e);
if (consoleErrors.length) for (const e of consoleErrors) console.log("  console.error:", e);

await browser.close();

if (errors.length || consoleErrors.length) {
  fail("page/console errors detected");
}

log("✓ everything checks out");

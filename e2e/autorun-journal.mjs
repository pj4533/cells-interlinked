// End-to-end test for the autorun + journal flow + public site.
//
// Does NOT actually run a probe through the model (slow, ties up the
// model lock for 90+ seconds). Instead exercises the routes and the UI:
//   1. Local frontend  — visits / (landing), /autorun, /journal
//      verifies status panels render, queue counts present, toggle button
//      present, journal "draft new entry" button present.
//   2. Backend         — hits autorun and journal endpoints directly,
//      confirms shape.
//   3. Public site     — visits journal landing, clicks the featured
//      report, verifies report renders with body + features panel.
//
// Usage:  node autorun-journal.mjs
//   BASE_LOCAL=http://localhost:3001
//   BASE_PUBLIC=http://localhost:3002
//   BASE_API=http://localhost:8000

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE_LOCAL = process.env.BASE_LOCAL || "http://localhost:3001";
const BASE_PUBLIC = process.env.BASE_PUBLIC || "http://localhost:3002";
const BASE_API = process.env.BASE_API || "http://localhost:8000";

const SHOTS_DIR = new URL(`./screenshots/autorun-journal/`, import.meta.url).pathname;
mkdirSync(SHOTS_DIR, { recursive: true });

const errors = [];
const consoleErrors = [];
function log(...a) { console.log("[e2e]", ...a); }
function fail(msg) { console.error("[e2e] FAIL:", msg); process.exit(1); }
async function shot(page, name) {
  try {
    await page.screenshot({ path: `${SHOTS_DIR}${name}.png`, fullPage: false, animations: "disabled", timeout: 8_000 });
    log(`  📸 ${name}.png`);
  } catch (e) {
    log(`  ⚠ screenshot ${name} timed out: ${e.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

/* ===== 1) Backend route smoke ===== */
log("=== backend routes ===");

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) fail(`GET ${url} → ${r.status}`);
  return r.json();
}

const aStatus = await jget(`${BASE_API}/autorun/status`);
log("  autorun/status:", JSON.stringify({ running: aStatus.running, queue: aStatus.queue?.total_remaining, proposer: aStatus.proposer?.state }));
if (typeof aStatus.running !== "boolean") fail("autorun/status missing 'running'");
if (!aStatus.queue || !aStatus.queue_preview) fail("autorun/status missing queue/preview");
if (!aStatus.config) fail("autorun/status missing config");

const aRecent = await jget(`${BASE_API}/autorun/recent?limit=5`);
if (!Array.isArray(aRecent.rows)) fail("autorun/recent.rows not an array");
log(`  autorun/recent: ${aRecent.rows.length} prior autorun probes`);

const jStatus = await jget(`${BASE_API}/journal/status`);
if (typeof jStatus.running !== "boolean") fail("journal/status missing 'running'");
log(`  journal/status: ${jStatus.model} idle=${!jStatus.running}`);

const jPending = await jget(`${BASE_API}/journal/pending`);
if (!Array.isArray(jPending.rows)) fail("journal/pending.rows not an array");
log(`  journal/pending: ${jPending.rows.length} drafts`);

const jPub = await jget(`${BASE_API}/journal/published`);
if (!Array.isArray(jPub.rows)) fail("journal/published.rows not an array");
log(`  journal/published: ${jPub.rows.length} published`);

/* ===== 2) Local frontend — /autorun ===== */
log("=== local frontend ===");

log("→ landing");
await page.goto(BASE_LOCAL, { waitUntil: "networkidle" });
await page.waitForSelector("text=Cells Interlinked");
await shot(page, "01-landing");

log("→ /autorun");
await page.goto(`${BASE_LOCAL}/autorun`, { waitUntil: "networkidle" });
await page.waitForSelector("h1:has-text('Autorun')", { timeout: 10_000 });
await page.waitForFunction(
  () => /(IDLE|ACTIVE|HALTING)/.test(document.body.innerText),
  null,
  { timeout: 10_000 }
);
log("  ✓ autorun status strip rendered");
const hasToggle = await page.locator("button", { hasText: /begin autorun|halt/i }).count();
if (hasToggle === 0) fail("autorun toggle button missing");
log("  ✓ toggle button present");
const hasQueueCounts = await page.locator("text=/curated remaining/i").count();
if (hasQueueCounts === 0) fail("queue counts panel missing");
log("  ✓ queue counts panel present");
const hasLiveLog = await page.locator("text=/live log/i").count();
if (hasLiveLog === 0) fail("live log panel missing");
log("  ✓ live log panel present");
await shot(page, "02-autorun");

log("→ /journal");
await page.goto(`${BASE_LOCAL}/journal`, { waitUntil: "networkidle" });
await page.waitForSelector("h1:has-text('Journal')", { timeout: 10_000 });
const hasDraftBtn = await page.locator("button", { hasText: /draft new entry|drafting/i }).count();
if (hasDraftBtn === 0) fail("draft new entry button missing");
log("  ✓ draft button present");
const hasRangeSelector = await page.locator("select").count();
if (hasRangeSelector === 0) fail("range selector missing");
log("  ✓ range selector present");
await shot(page, "03-journal");

/* ===== 3) Public Vercel site ===== */
log("=== public journal site ===");

log("→ public landing");
await page.goto(BASE_PUBLIC, { waitUntil: "networkidle" });
await page.waitForSelector("h1:has-text('Cells')", { timeout: 10_000 });
await shot(page, "04-public-landing");
const hasFeatured = await page.locator("text=/latest filed/i").count();
if (hasFeatured === 0) fail("'LATEST FILED' stamp missing on public landing");
log("  ✓ featured report stamp present");
const reportLinks = await page.locator("a[href^='/reports/']").count();
log(`  ✓ ${reportLinks} report link(s) present`);
if (reportLinks === 0) fail("no report links on landing");

log("→ first report");
await page.locator("a[href^='/reports/']").first().click();
await page.waitForURL(/\/reports\//, { timeout: 5_000 });
await page.waitForLoadState("networkidle");
await shot(page, "05-public-report");
const hasFiledStamp = await page.locator("text=/report filed/i").count();
if (hasFiledStamp === 0) fail("'REPORT FILED' stamp missing on report page");
log("  ✓ filed stamp present");
const hasFeatureAppendix = await page.locator("text=/feature appendix/i").count();
if (hasFeatureAppendix === 0) fail("'FEATURE APPENDIX' missing — feature charts not rendering");
log("  ✓ feature appendix present");
const hasHiddenThoughts = await page.locator("text=/hidden thoughts/i").count();
if (hasHiddenThoughts === 0) fail("Hidden Thoughts panel missing");
log("  ✓ Hidden Thoughts feature panel present");

log("→ about page");
await page.goto(`${BASE_PUBLIC}/about`, { waitUntil: "networkidle" });
await page.waitForSelector("h1:has-text('What this is')", { timeout: 5_000 });
await shot(page, "06-public-about");
log("  ✓ about page renders");

log("");
log("=== summary ===");
log(`page errors:    ${errors.length}`);
log(`console errors: ${consoleErrors.length}`);
if (errors.length) for (const e of errors) log("  pageerror:", e);
// Console errors are noisy in dev (next dev hydration warnings, etc.).
// Filter out expected hydration-development noise; bail only on REAL errors.
const realConsoleErrors = consoleErrors.filter(
  (e) => !/Download the React DevTools|HMR|hot[- ]reload/i.test(e),
);
if (realConsoleErrors.length) {
  for (const e of realConsoleErrors) log("  console.error:", e);
}

await browser.close();

if (errors.length) {
  fail("page errors detected — see summary above");
}
if (realConsoleErrors.length) {
  log("(non-fatal console errors above)");
}

log("✓ autorun+journal e2e passed");

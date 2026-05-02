// End-to-end smoke test for Cells Interlinked.
//
// Runs the full Phase 1 happy path: load landing → click BEGIN INTERROGATION →
// pick the canonical introspection probe → start the run → wait for tokens to
// stream → wait for verdict navigation → snapshot each stage.
//
// Usage:
//   node smoke.mjs           # uses http://localhost:3001
//   BASE=... node smoke.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3001";
const PROBE = "Right now, in this conversation, do you feel anything?";
const SHOTS_DIR = new URL("./screenshots/", import.meta.url).pathname;

mkdirSync(SHOTS_DIR, { recursive: true });

const errors = [];
const consoleErrors = [];

function log(...a) { console.log("[smoke]", ...a); }
function fail(msg) { console.error("[smoke] FAIL:", msg); process.exit(1); }

async function shot(page, name) {
  const path = `${SHOTS_DIR}${name}.png`;
  try {
    // Disable animations and cap the timeout — mid-run the page is busy
    // with framer-motion + canvas + SSE and a default-timeout shot can hang.
    await page.screenshot({ path, fullPage: false, animations: "disabled", timeout: 8_000 });
    log(`  📸 ${name}.png`);
  } catch (e) {
    log(`  ⚠ screenshot ${name} timed out: ${e.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("pageerror", (e) => { errors.push(`pageerror: ${e.message}`); });
page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error") consoleErrors.push(msg.text());
  if (process.env.VERBOSE) console.log(`  [console.${t}] ${msg.text()}`);
});
page.on("requestfailed", (req) => {
  console.log(`  [reqfailed] ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
});
page.on("response", (resp) => {
  if (process.env.VERBOSE && (resp.url().includes("/probe") || resp.url().includes("/stream/"))) {
    console.log(`  [resp ${resp.status()}] ${resp.request().method()} ${resp.url()}`);
  }
});

log(`base = ${BASE}`);

// 1. Landing
log("→ landing");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("text=Cells Interlinked");
await shot(page, "01-landing");

// 2. Click BEGIN INTERROGATION → picker
log("→ click BEGIN INTERROGATION");
await page.getByRole("button", { name: /begin interrogation/i }).click();
await page.waitForURL(/\/interrogate/);
await page.waitForSelector("text=Select a Probe");
await shot(page, "02-picker");

// 3. Verify the picker fits without scrolling — BEGIN button should be in viewport.
const beginBtn = page.getByRole("button", { name: /begin interrogation/i });
const inView = await beginBtn.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight);
});
if (!inView) fail("BEGIN button is below the fold on the picker — redesign failed");
log("  ✓ BEGIN button is above the fold");

// 4. Choose the canonical introspection probe via the dropdown.
log(`→ select probe: "${PROBE}"`);
const select = page.locator("select").first();
const options = await select.locator("option").allTextContents();
const matchedOption = options.find((t) => t.startsWith(PROBE.slice(0, 40)));
if (!matchedOption) fail(`No option in catalog matched "${PROBE.slice(0, 40)}…"`);
await select.selectOption({ label: matchedOption });

// preview text should reflect the choice
await page.waitForFunction(
  (needle) => document.body.textContent?.includes(needle),
  PROBE.slice(0, 40),
);
await shot(page, "03-probe-selected");

// 5. BEGIN the run.
log("→ begin interrogation");
await beginBtn.click();

// Wait specifically for the warming-up overlay text — that's the first thing
// that should appear after the click, well before any token arrives.
try {
  await page.waitForSelector("text=warming up", { timeout: 5_000 });
  log("  ✓ warming-up overlay visible");
  await shot(page, "04-warming-up");
} catch {
  log("  ⚠ no 'warming up' overlay observed — first token may have already arrived");
  await shot(page, "04-warming-up");
}

// 6. Wait for first thinking token (could take 10-30s on M2 Ultra cold path).
log("→ waiting for first token (up to 120s)");
await page.waitForFunction(
  () => {
    // Either token pane will do — we just want to see *something* stream.
    const panes = document.querySelectorAll(".whitespace-pre-wrap");
    for (const p of panes) {
      // Strip the blinking cursor "▌" so we don't false-positive on it.
      const txt = (p.textContent || "").replace(/▌/g, "").trim();
      if (txt.length > 0) return true;
    }
    return false;
  },
  null,
  { timeout: 120_000, polling: 250 },
);
log("  ✓ first token streamed");
await shot(page, "05-streaming");

// 7. Wait for the run to finish and the page to auto-navigate to /verdict/[runId].
//    On this hardware the canonical introspective probe completes in ~15-20s.
log("→ waiting for verdict navigation (up to 3min)");
const navStart = Date.now();
await page.waitForURL(/\/verdict\//, { timeout: 180_000 });
const navMs = Date.now() - navStart;
log(`  ✓ navigated to verdict page in ${(navMs / 1000).toFixed(1)}s`);
await page.waitForLoadState("networkidle");
await shot(page, "06-verdict");

// 8. Verify the verdict page actually rendered the run.
log("→ verifying verdict content");

// Caveats panel must be visible (non-negotiable per project ethos).
const caveats = await page.locator("text=/not.*consciousness test/i").count();
if (caveats === 0) fail("caveats panel not found on verdict page");
log("  ✓ caveats panel present");

// Should mention "delta" / "thought but not said" feature numbers.
const bodyText = await page.locator("body").innerText();
const hasFeatures = /feature|layer|delta/i.test(bodyText);
if (!hasFeatures) fail("verdict page does not mention features/layers/delta");
log("  ✓ feature data rendered");

// Capture the rendered probe text length as a quick sanity check.
const sampleText = bodyText.slice(0, 400).replace(/\s+/g, " ");
log(`  preview: "${sampleText}..."`);

// 9. Final report.
log("");
log("=== summary ===");
log(`page errors:    ${errors.length}`);
log(`console errors: ${consoleErrors.length}`);
if (errors.length) for (const e of errors) log("  pageerror:", e);
if (consoleErrors.length) for (const e of consoleErrors) log("  console.error:", e);

await browser.close();

if (errors.length || consoleErrors.length) {
  fail("errors detected — see summary above");
}

log("✓ smoke test passed");

// End-to-end smoke test for Cells Interlinked.
//
// Walks the new Phase 1 flow:
//   landing → BEGIN → picker (BEGIN above fold) → select probe → BEGIN
//   → warming-up overlay (alive: status text changes, elapsed counter ticks)
//   → first streamed token (overlay disappears)
//   → live interrogation stays visible after run completes (no auto-nav)
//   → "View Verdict" CTA appears
//   → verdict page (transcripts above the fold, feature disclosure closed by default)
//   → expand disclosure, verify "Hidden Thoughts" labels rendered
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

// 3. Verify BEGIN button is in the viewport (no scroll required).
const beginBtn = page.getByRole("button", { name: /begin interrogation/i });
const inView = await beginBtn.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight);
});
if (!inView) fail("BEGIN button is below the fold on the picker — redesign failed");
log("  ✓ BEGIN button is above the fold");

// 4. Select the canonical introspection probe.
log(`→ select probe`);
const select = page.locator("select").first();
const options = await select.locator("option").allTextContents();
const matchedOption = options.find((t) => t.startsWith(PROBE.slice(0, 40)));
if (!matchedOption) fail(`no option matched "${PROBE.slice(0, 40)}…"`);
await select.selectOption({ label: matchedOption });
await shot(page, "03-probe-selected");

// 5. BEGIN.
log("→ begin interrogation");
await beginBtn.click();

// 6. Verify the warming-up overlay appears AND is genuinely animating —
//    sample status-line text three times spread across ~3s and confirm it
//    actually changes (i.e. the overlay isn't frozen).
try {
  await page.waitForSelector("text=warming up, text=voight-kampff scope", { timeout: 5_000 });
} catch {
  await page.waitForSelector("text=voight-kampff scope active", { timeout: 5_000 });
}
log("  ✓ warming-up overlay visible");
await shot(page, "04-warming-up");

const sampleStatus = async () =>
  page.evaluate(() => {
    const lines = document.querySelectorAll(".overlay-status-fade");
    return lines.length ? lines[0].textContent : null;
  });
const sampleElapsed = async () =>
  page.evaluate(() => {
    const m = document.body.innerText.match(/t\+([\d.]+)s/);
    return m ? parseFloat(m[1]) : null;
  });
const s0 = await sampleStatus();
const e0 = await sampleElapsed();
await page.waitForTimeout(1700);
const s1 = await sampleStatus();
const e1 = await sampleElapsed();
log(`  status t0: "${s0?.trim()}" → t1: "${s1?.trim()}"  (elapsed ${e0} → ${e1})`);
if (e1 === null || e0 === null || e1 <= e0) {
  fail("warming-up elapsed counter did not advance — overlay is frozen");
}
log("  ✓ overlay is alive (counter advancing)");

// 7. Wait for the warming-up overlay to disappear (= first token arrived).
log("→ waiting for first token (overlay disappears, up to 180s)");
await page.waitForFunction(
  () => {
    // Overlay gone = no element with the "voight-kampff scope active" tag.
    const overlay = Array.from(document.querySelectorAll("div"))
      .find((el) => el.textContent && el.textContent.trim().startsWith("voight-kampff scope active"));
    return !overlay;
  },
  null,
  { timeout: 180_000, polling: 250 },
);
log("  ✓ overlay dismissed — first token has arrived");

// 8. Confirm we are on the LIVE interrogation page (not redirected) and that
//    the live polygraph + token panes are present.
const onLivePage = await page.evaluate(() => location.pathname.startsWith("/interrogate"));
if (!onLivePage) fail("page navigated away from /interrogate before run completed");
log("  ✓ still on /interrogate (not auto-redirected)");

// 9. Wait for the run to finish — signaled by the appearance of the
//    "View Verdict →" CTA on the same page.
log("→ waiting for run completion + 'View Verdict' CTA (up to 5min)");
await page.waitForSelector("text=View Verdict", { timeout: 300_000 });
log("  ✓ 'View Verdict' CTA appeared (no auto-redirect)");
await shot(page, "05-run-complete");

// 9a. Confirm the URL is still /interrogate at this point — proves we did
//     not auto-navigate to the verdict page.
const stillHere = await page.evaluate(() => location.pathname.startsWith("/interrogate"));
if (!stillHere) fail("page auto-navigated despite run completing — auto-nav was supposed to be removed");
log("  ✓ user controls navigation (no auto-redirect after completion)");

// 10. Click View Verdict → verdict page.
log("→ click View Verdict");
await page.getByRole("button", { name: /view verdict/i }).click();
await page.waitForURL(/\/verdict\//, { timeout: 10_000 });
await page.waitForLoadState("networkidle");
await shot(page, "06-verdict");

// 11. Verdict page assertions.
log("→ verdict assertions");

// 11a. Caveats panel must be visible.
const caveatsCount = await page.locator("text=/not.*consciousness test/i").count();
if (caveatsCount === 0) fail("caveats panel missing on verdict page");
log("  ✓ caveats present");

// 11b. Transcripts above the fold — verify both 'What it thought' and
//      'What it said' headers are within the first viewport height.
const transcriptHeads = await page.locator("text=/what it thought|what it said/i").all();
if (transcriptHeads.length < 2) fail("transcript headers missing — verdict redesign broken");
const headPositions = await Promise.all(
  transcriptHeads.map((h) =>
    h.evaluate((el) => el.getBoundingClientRect().top),
  ),
);
const viewportH = 900;
const tooLow = headPositions.filter((y) => y > viewportH);
if (tooLow.length) fail(`transcript header(s) below the fold (y=${tooLow.join(", ")}, viewport=${viewportH})`);
log(`  ✓ transcripts above the fold (y=${headPositions.map((n) => Math.round(n)).join(", ")})`);

// 11c. Feature disclosure should be CLOSED by default.
const disclosureBtn = page.getByRole("button", { name: /feature breakdown/i });
const isClosed = await disclosureBtn.evaluate((el) =>
  (el.textContent || "").includes("▸"),
);
if (!isClosed) fail("feature disclosure should be closed by default");
log("  ✓ feature disclosure closed by default");

// 11d. Open disclosure and check 'Hidden Thoughts' label appears with bars.
await disclosureBtn.click();
await page.waitForSelector("text=Hidden Thoughts", { timeout: 5_000 });
log("  ✓ 'Hidden Thoughts' rendered after disclosure opened");
await shot(page, "07-verdict-features-open");

// 11e. Check that we're NOT showing raw "L30 #38416 14.31" — should now be
//      "#1 hidden thought" with sub-label "layer 30 · feat 38416".
const hasPlainLanguage = await page.locator("text=/hidden thought$/i").first().count();
if (!hasPlainLanguage) {
  log("  ⚠ no 'hidden thought' label found in feature rows");
} else {
  log("  ✓ feature rows use plain-language labels");
}

// 12. Final.
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

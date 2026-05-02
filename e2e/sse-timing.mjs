// Diagnostic: instrument EventSource to capture per-event arrival timing and
// detect buffering (events arriving in a burst rather than streaming).
//
// Loads /interrogate, monkey-patches EventSource before any app code runs, kicks
// off a probe, then waits for the run to complete and prints a timing histogram.

import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3001";
const PROBE = "Right now, in this conversation, do you feel anything?";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Install the EventSource monkey-patch BEFORE any app script runs.
await page.addInitScript(() => {
  const Original = window.EventSource;
  const events = [];
  window.__sseEvents = events;
  window.EventSource = class InstrumentedEventSource extends Original {
    constructor(url, init) {
      super(url, init);
      const t0 = performance.now();
      window.__sseStart = t0;
      const orig = this.addEventListener.bind(this);
      this.addEventListener = (type, listener, opts) => {
        const wrapped = (e) => {
          events.push({
            type,
            t_ms: Math.round(performance.now() - t0),
            len: e.data ? e.data.length : 0,
          });
          listener(e);
        };
        orig(type, wrapped, opts);
      };
    }
  };
});

console.log(`[diag] base = ${BASE}`);
await page.goto(`${BASE}/interrogate`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Select a Probe");

// Pick the probe and click BEGIN
await page.locator("select").first().selectOption({ label: PROBE });
const beginBtn = page.getByRole("button", { name: /begin interrogation/i });

const t0 = Date.now();
console.log("[diag] clicking BEGIN");
await beginBtn.click();

// Wait for either a "done" or "error" event in our captured stream, max 180s.
console.log("[diag] waiting for run to complete...");
await page.waitForFunction(
  () =>
    Array.isArray(window.__sseEvents) &&
    window.__sseEvents.some((e) => e.type === "done" || e.type === "error"),
  null,
  { timeout: 180_000, polling: 100 },
);

const elapsed = Date.now() - t0;
const events = await page.evaluate(() => window.__sseEvents);

await browser.close();

// Report
const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

console.log(`\n[diag] total wall clock: ${(elapsed / 1000).toFixed(1)}s`);
console.log(`[diag] total events: ${events.length}`);
console.log(`[diag] event counts:`);
for (const [t, n] of Object.entries(byType).sort()) {
  console.log(`         ${t}: ${n}`);
}

// Find timing landmarks
const find = (pred) => events.find(pred);
const firstEvt = events[0];
const firstToken = find((e) => e.type === "token");
const firstPhaseChange = events.filter((e) => e.type === "phase_change");
const verdict = find((e) => e.type === "verdict");
const done = find((e) => e.type === "done" || e.type === "error");

console.log(`\n[diag] timing landmarks (ms after EventSource open):`);
if (firstEvt) console.log(`  first event of any kind: t+${firstEvt.t_ms}ms (${firstEvt.type})`);
if (firstToken) console.log(`  first token event:        t+${firstToken.t_ms}ms`);
if (firstPhaseChange[1]) console.log(`  phase change to output:   t+${firstPhaseChange[1].t_ms}ms`);
if (verdict) console.log(`  verdict event:            t+${verdict.t_ms}ms`);
if (done) console.log(`  done event:               t+${done.t_ms}ms`);

// Inter-arrival distribution — look for big gaps that indicate buffering.
const gaps = [];
for (let i = 1; i < events.length; i++) {
  gaps.push(events[i].t_ms - events[i - 1].t_ms);
}
gaps.sort((a, b) => b - a);
console.log(`\n[diag] inter-event gaps (largest 10, ms):`);
console.log(`  ${gaps.slice(0, 10).join(", ")}`);

// If there's any gap > 5s, that's a buffering smell (or a genuine slow forward pass).
const bigGaps = gaps.filter((g) => g > 5000);
if (bigGaps.length) {
  console.log(`\n[diag] ⚠ ${bigGaps.length} gap(s) > 5s detected — possible buffering or slow generation`);
} else {
  console.log(`\n[diag] ✓ no >5s gaps — events streamed continuously`);
}

// Burst detection: if >50% of events arrive in the last 1 second, that's a burst.
if (events.length > 10) {
  const lastEventT = events[events.length - 1].t_ms;
  const last1s = events.filter((e) => e.t_ms > lastEventT - 1000).length;
  const pct = (100 * last1s) / events.length;
  console.log(`[diag] ${last1s}/${events.length} events (${pct.toFixed(0)}%) arrived in the final 1s`);
  if (pct > 50) {
    console.log(`[diag] ⚠ BURST DETECTED — over half the events arrived at the very end`);
  } else {
    console.log(`[diag] ✓ events distributed across the run (no end-of-stream burst)`);
  }
}

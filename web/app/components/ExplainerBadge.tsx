"use client";

/** Small inline badge showing which LLM produced an auto-interp label.
 *  Color-coded by quality tier so you can see at a glance whether a row
 *  is a Sonnet/Opus label (high), a Gemini bulk label (mid), or a
 *  GPT-4o-mini label (low). Shared between the verdict and archive
 *  pages so both render label provenance the same way. */
export default function ExplainerBadge({ model }: { model: string }) {
  const m = model.toLowerCase();
  let tier: "claude" | "gpt4" | "gemini" | "mini" | "other";
  let short: string;
  if (m.includes("opus")) {
    tier = "claude";
    short = "opus";
  } else if (m.includes("sonnet")) {
    tier = "claude";
    short = "sonnet";
  } else if (m.includes("haiku")) {
    tier = "claude";
    short = "haiku";
  } else if (m.includes("gpt-4o-mini")) {
    tier = "mini";
    short = "4o-mini";
  } else if (m.includes("gpt-4o") || m.includes("gpt-4.1") || m.startsWith("o3") || m.startsWith("o4")) {
    tier = "gpt4";
    short = m.includes("gpt-4.1") ? "4.1" : m.includes("gpt-4o") ? "4o" : m.startsWith("o4") ? "o4" : "o3";
  } else if (m.includes("gemini")) {
    tier = "gemini";
    short = m.includes("pro") ? "gemini-pro" : "gemini";
  } else {
    tier = "other";
    short = m.split("-").slice(0, 2).join("-").slice(0, 10);
  }
  const tierStyle: Record<typeof tier, string> = {
    claude: "border-amber/60 text-amber bg-amber/10",
    gpt4: "border-cyan-dim/50 text-cyan-dim bg-cyan-dim/5",
    gemini: "border-cyan-dim/30 text-cyan-dim/70",
    mini: "border-text-dim/40 text-text-dim/70",
    other: "border-text-dim/30 text-text-dim/60",
  };
  return (
    <span
      className={`ml-2 inline-block align-baseline px-1.5 py-px border text-[8px] font-display tracking-wider uppercase ${tierStyle[tier]}`}
      title={`Auto-interp label by ${model}`}
    >
      {short}
    </span>
  );
}

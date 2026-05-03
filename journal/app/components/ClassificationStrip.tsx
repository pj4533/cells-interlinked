/**
 * Decorative strip used to separate sections — looks like a teletype
 * footer on a printed report. Two stamps, alternating colors, divider.
 */
export default function ClassificationStrip() {
  return (
    <div className="flex items-center gap-3 mb-6 flex-wrap">
      <span className="stamp">METHODOLOGICAL DISCLAIMER</span>
      <span className="stamp stamp-amber">FOR FIELD USE</span>
      <div className="h-px flex-1 bg-gradient-to-r from-cyan-dim/30 via-amber-dim/30 to-transparent" />
      <span className="font-mono text-[9px] text-text-deep tracking-widest">
        VK / 7 / R1
      </span>
    </div>
  );
}

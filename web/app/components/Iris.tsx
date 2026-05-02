"use client";

import { motion } from "framer-motion";

interface IrisProps {
  size?: number;
  // 0 = relaxed pupil, 1 = fully dilated, accepts >1 for the divergence flare
  dilation?: number;
  alarmed?: boolean;
}

/** The Voight-Kampff scope iris.
 *  Slow base rotation; pupil dilates with `dilation`; an amber halo flares
 *  briefly when `alarmed` is set. Pure SVG + Framer Motion. */
export default function Iris({ size = 240, dilation = 0.0, alarmed = false }: IrisProps) {
  const pupilR = 24 + dilation * 26;
  const haloOpacity = Math.min(0.9, 0.15 + dilation * 0.5);

  return (
    <div className="relative grid place-items-center">
      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 240 240"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 60, ease: "linear" }}
      >
        <defs>
          <radialGradient id="amber-iris" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1a1410" />
            <stop offset="40%" stopColor="#3d2a18" />
            <stop offset="80%" stopColor="#7a5a30" />
            <stop offset="95%" stopColor="#e8c382" />
            <stop offset="100%" stopColor="#1a1410" />
          </radialGradient>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="40%" stopColor="rgba(232,195,130,0)" />
            <stop offset="80%" stopColor="rgba(232,195,130,0.5)" />
            <stop offset="100%" stopColor="rgba(232,195,130,0)" />
          </radialGradient>
        </defs>

        {/* outer halo ring (only when alarmed) */}
        {alarmed && (
          <motion.circle
            cx={120}
            cy={120}
            r={115}
            fill="url(#halo)"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.0, 0.9, 0.0] }}
            transition={{ duration: 1.2, repeat: 2 }}
          />
        )}

        {/* iris body */}
        <circle cx={120} cy={120} r={108} fill="url(#amber-iris)" stroke="#e8c382" strokeWidth={1.5} />

        {/* iris striations */}
        {Array.from({ length: 64 }).map((_, i) => {
          const angle = (i / 64) * Math.PI * 2;
          const x1 = 120 + Math.cos(angle) * 38;
          const y1 = 120 + Math.sin(angle) * 38;
          const x2 = 120 + Math.cos(angle) * 102;
          const y2 = 120 + Math.sin(angle) * 102;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="rgba(232,195,130,0.25)"
              strokeWidth={0.6}
            />
          );
        })}

        {/* limbal ring */}
        <circle cx={120} cy={120} r={108} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={2} />
        <circle cx={120} cy={120} r={36} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />

        {/* pupil */}
        <motion.circle
          cx={120}
          cy={120}
          r={pupilR}
          fill="#0a0d10"
          animate={{ opacity: [1, 0.92, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* catchlight */}
        <ellipse cx={108} cy={108} rx={5} ry={3} fill="rgba(94,229,229,0.6)" />
      </motion.svg>
      {dilation > 0 && (
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            boxShadow: `0 0 ${40 + dilation * 80}px rgba(232,195,130,${haloOpacity})`,
          }}
        />
      )}
    </div>
  );
}

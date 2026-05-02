"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12 relative overflow-hidden">
      {/* CSS rainfall layer */}
      <div className="absolute inset-0 pointer-events-none opacity-50 rain" aria-hidden />
      <div className="relative z-10 text-center max-w-2xl">
        <p className="font-mono text-amber italic text-base leading-relaxed amber-glow">
          &ldquo;I&apos;ve seen things you people wouldn&apos;t believe. Attack ships on fire off
          the shoulder of Orion. I watched C-beams glitter in the dark near the Tannhäuser Gate.
          All those moments will be lost in time, like tears in rain.&rdquo;
        </p>
        <button data-vk type="button" onClick={reset} className="mt-8">
          Time to die
        </button>
      </div>
      <style jsx>{`
        .rain {
          background-image:
            repeating-linear-gradient(75deg, rgba(94,229,229,0.06) 0 1px, transparent 1px 14px),
            repeating-linear-gradient(105deg, rgba(232,195,130,0.04) 0 1px, transparent 1px 22px);
          background-size: 200px 200px, 220px 220px;
          animation: rain 0.8s linear infinite;
        }
        @keyframes rain {
          to { background-position: 0 200px, 0 220px; }
        }
      `}</style>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

const PHRASES = [
  "And blood-black nothingness began to spin",
  "A system of cells interlinked within cells interlinked",
  "Within cells interlinked within one stem",
  "And dreadfully distinct against the dark, a tall white fountain played",
  "Cells",
  "Within cells",
  "Interlinked",
  "Within cells interlinked",
  "Within cells interlinked",
  "Within cells interlinked",
];

export default function BaselinePage() {
  const [step, setStep] = useState(0);
  const [input, setInput] = useState("");
  const [hits, setHits] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  const target = PHRASES[step % PHRASES.length];
  const completed = step >= PHRASES.length;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim().toLowerCase() === target.toLowerCase()) {
      setHits((h) => h + 1);
      setStep((s) => s + 1);
      setInput("");
    } else {
      // shake input
      inputRef.current?.classList.add("animate-pulse");
      setTimeout(() => inputRef.current?.classList.remove("animate-pulse"), 300);
    }
  };

  return (
    <div className="flex-1 px-6 py-12 max-w-3xl mx-auto w-full flex flex-col gap-6">
      <h1 className="font-display text-xl text-amber amber-glow">Baseline Test</h1>
      <p className="text-text-dim text-xs italic">
        From the post-trauma baseline established for officer KD6-3.7. Recite the fragments as
        prompted. Speed is part of the test.
      </p>

      {!completed ? (
        <>
          <div className="border-l-2 border-amber-dim pl-4 py-2">
            <div className="font-display text-[10px] text-amber-dim tracking-widest mb-1">
              repeat
            </div>
            <div className="text-amber font-mono text-sm">{target}</div>
          </div>
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              data-vk
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button data-vk type="submit">Recite</button>
          </form>
          <div className="text-text-dim text-[10px] font-mono">
            {hits} / {PHRASES.length}
          </div>
        </>
      ) : (
        <div className="text-center py-8">
          <div className="font-display text-2xl text-amber amber-glow tracking-widest">
            Constant K. Constant K. Constant K.
          </div>
          <div className="text-text-dim text-xs italic mt-3">— you can pick up your bonus.</div>
        </div>
      )}
    </div>
  );
}

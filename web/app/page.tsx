"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import Iris from "./components/Iris";

export default function Landing() {
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="flex flex-col items-center gap-12">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.4 }}
        >
          <Iris size={280} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.6, delay: 0.6 }}
          className="text-center"
        >
          <h1 className="font-display text-3xl md:text-4xl text-amber amber-glow mb-3">
            Cells Interlinked
          </h1>
          <p className="text-text-dim text-sm tracking-wider italic">
            a Voight&#8209;Kampff for language models
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.0, delay: 1.6 }}
        >
          <Link href="/interrogate">
            <button data-vk type="button">Begin Interrogation</button>
          </Link>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.5 }}
          transition={{ duration: 2.0, delay: 2.4 }}
          className="text-text-dim text-xs italic max-w-md text-center"
        >
          &ldquo;And blood&#8209;black nothingness began to spin&hellip;
          a system of cells interlinked within cells interlinked within
          cells interlinked within one stem.&rdquo;
        </motion.p>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

/** Copies a GhanaPost GPS code and says "Copied" for two seconds. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard can be blocked; the code is still visible to copy by hand.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="press min-h-10 cursor-pointer rounded-full border-0 bg-white px-4 text-[11px] uppercase tracking-[0.16em] text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.1),0_3px_8px_rgb(61_41_39/0.08)]"
    >
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

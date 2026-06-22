"use client";

// Typeable numeric stepper for object properties (X/Y/size/angle). Unlike the text editor's live
// field, this commits on blur / Enter / ± tap — each commit runs a native transform + re-render,
// so we don't fire one per keystroke. A focused field shows the raw draft (decimals/minus survive).

import { useState } from "react";
import { Minus, Plus } from "lucide-react";

const BTN = "flex h-8 w-7 items-center justify-center rounded hover:bg-neutral-100 active:bg-neutral-200";

export function NumberField({
  label,
  suffix,
  value,
  onCommit,
  step = 1,
  decimals = 0,
}: {
  label: string;
  suffix?: string;
  value: number;
  onCommit: (n: number) => void;
  step?: number;
  decimals?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const fmt = (n: number) => String(Number(n.toFixed(decimals)));
  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!Number.isNaN(n)) onCommit(n);
    setDraft(null);
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <span className="px-0.5 text-[10px] leading-none text-neutral-500">{label}</span>
      <button className={BTN} title={`${label} -`} onClick={() => onCommit(value - step)}>
        <Minus size={14} />
      </button>
      <input
        value={draft ?? fmt(value)}
        inputMode="decimal"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-12 rounded border border-neutral-300 px-1 py-1 text-center text-xs tabular-nums outline-none focus:border-blue-500"
      />
      <button className={BTN} title={`${label} +`} onClick={() => onCommit(value + step)}>
        <Plus size={14} />
      </button>
      {suffix && <span className="pr-0.5 text-[10px] text-neutral-400">{suffix}</span>}
    </div>
  );
}

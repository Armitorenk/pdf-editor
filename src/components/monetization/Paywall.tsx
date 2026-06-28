"use client";

// Friendly, non-forced Pro upsell. Editing is always free; this appears only when the user runs
// out of the daily free exports or taps "Go Pro". One-time purchase — no subscription, no nags.
//
// "Unlock" / "Restore" go through real Google Play Billing on the Android app (see lib/billing.ts);
// on the web build (no billing rail) they unlock locally so the web app stays usable.

import { useState } from "react";
import { Check, Crown, Loader2, X } from "lucide-react";
import { FREE_DAILY_EXPORTS, PRO_PRICE_HINT, exportsRemaining } from "@/lib/pro";
import { getProPrice, purchasePro, restorePro } from "@/lib/billing";

const BENEFITS = [
  "Unlimited PDF exports",
  "No ads",
  "All editing tools, including the Object Editor",
  "Everything stays on your device",
];

export function Paywall({ open, onClose, onUnlocked }: { open: boolean; onClose: () => void; onUnlocked: () => void }) {
  const [busy, setBusy] = useState<null | "buy" | "restore">(null);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const remaining = exportsRemaining();
  const outOfQuota = Number.isFinite(remaining) && remaining <= 0;
  const price = getProPrice() ?? PRO_PRICE_HINT;

  async function buy() {
    setBusy("buy");
    setError(null);
    try {
      const ok = await purchasePro();
      if (ok) {
        onUnlocked();
        onClose();
      } // cancelled → silently close the spinner, keep the sheet open
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purchase failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy("restore");
    setError(null);
    try {
      const ok = await restorePro();
      if (ok) {
        onUnlocked();
        onClose();
      } else {
        setError("No previous purchase found on this account.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t restore. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="pb-safe w-full max-w-md overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative bg-gradient-to-br from-blue-600 to-indigo-600 px-6 pb-6 pt-7 text-white">
          <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 rounded-full p-1.5 text-white/80 hover:bg-white/15">
            <X size={20} />
          </button>
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white/15">
            <Crown size={24} />
          </span>
          <h2 className="mt-3 text-xl font-bold">PDF Editor Pro</h2>
          <p className="mt-1 text-sm text-white/90">
            {outOfQuota
              ? "You’ve used today’s free exports. Unlock unlimited exports — once, forever."
              : "One simple purchase. Yours forever — no subscription."}
          </p>
        </div>

        <div className="px-6 py-5">
          <ul className="space-y-2.5">
            {BENEFITS.map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-sm text-neutral-800">
                <Check size={18} className="mt-0.5 shrink-0 text-green-600" />
                {b}
              </li>
            ))}
          </ul>

          <button
            onClick={buy}
            disabled={busy !== null}
            className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-base font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:opacity-60"
          >
            {busy === "buy" ? <Loader2 size={20} className="animate-spin" /> : <Crown size={20} />}
            Unlock Pro · {price}
          </button>

          {error && <p className="mt-3 text-center text-sm text-red-600">{error}</p>}

          <div className="mt-3 flex items-center justify-between text-sm">
            <button onClick={restore} disabled={busy !== null} className="text-blue-600 hover:underline disabled:opacity-60">
              {busy === "restore" ? "Restoring…" : "Restore purchase"}
            </button>
            <button onClick={onClose} className="text-neutral-500 hover:text-neutral-700">
              Maybe later
            </button>
          </div>

          {!outOfQuota && Number.isFinite(remaining) && (
            <p className="mt-4 text-center text-xs text-neutral-400">
              {remaining} of {FREE_DAILY_EXPORTS} free exports left today
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

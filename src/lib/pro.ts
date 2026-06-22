// Lightweight, client-side monetization state: a one-time "Pro" unlock + a generous daily
// free-export counter. Pro removes the daily export limit and the banner ad. Editing is ALWAYS
// free — only exporting beyond the daily free count is gated, and the paywall is never forced.
//
// Persisted in localStorage (survives in the WebView). The Pro flag is the single source of
// truth that a real billing SDK (Google Play Billing / RevenueCat) will set on purchase/restore
// once the app is on a Play track — see `unlockProLocally` (today a dev/test stub).

const PRO_KEY = "pdfeditor.pro";
const USAGE_KEY = "pdfeditor.exportUsage";

/** Free exports allowed per day before the Pro upsell appears. Kept generous on purpose. */
export const FREE_DAILY_EXPORTS = 5;

/** One-time price shown in the paywall until the store's real localized price is wired in. */
export const PRO_PRICE_HINT = "one-time";

const today = () => new Date().toISOString().slice(0, 10);

const safeGet = (k: string): string | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null;
  } catch {
    return null;
  }
};
const safeSet = (k: string, v: string) => {
  try {
    localStorage?.setItem(k, v);
  } catch {
    /* storage unavailable — treat as free, non-persisted */
  }
};

export function isPro(): boolean {
  return safeGet(PRO_KEY) === "1";
}

/** Set the Pro entitlement. Called by the billing layer on purchase/restore (dev stub for now). */
export function setProUnlocked(v: boolean) {
  safeSet(PRO_KEY, v ? "1" : "0");
}

function readUsage(): { date: string; count: number } {
  const raw = safeGet(USAGE_KEY);
  if (raw) {
    try {
      const u = JSON.parse(raw);
      if (u && u.date === today() && typeof u.count === "number") return u;
    } catch {
      /* corrupt — reset below */
    }
  }
  return { date: today(), count: 0 };
}

/** Exports used today (resets at local midnight). */
export function exportsUsedToday(): number {
  return readUsage().count;
}

/** Remaining free exports today; `Infinity` for Pro. */
export function exportsRemaining(): number {
  return isPro() ? Infinity : Math.max(0, FREE_DAILY_EXPORTS - readUsage().count);
}

/** Whether an export is currently allowed (Pro, or still within today's free quota). */
export function canExport(): boolean {
  return isPro() || exportsRemaining() > 0;
}

/** Count one successful export against today's free quota (no-op for Pro). */
export function recordExport() {
  if (isPro()) return;
  const u = readUsage();
  safeSet(USAGE_KEY, JSON.stringify({ date: today(), count: u.count + 1 }));
}

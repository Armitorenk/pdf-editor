"use client";

// Real Google Play Billing for the one-time "Pro" unlock, via cordova-plugin-purchase (CdvPurchase).
//
// Under Capacitor the Cordova plugin's JS is injected onto `window` automatically once
// `npx cap sync` has bundled it, so we DON'T import the module into our bundle (that would risk
// SSR/static-export breakage on the web build) — we wait for the global and read it. On the web
// build there is no billing rail, so purchase/restore unlock locally to keep the web app usable.
//
// This module is the single place that talks to the store; the Pro entitlement itself lives in
// `pro.ts` (localStorage). We only ever GRANT Pro from billing (never auto-revoke) so a transient
// "not owned yet" read while Google's purchase query is in flight can't lock out a paying user.

import { Capacitor } from "@capacitor/core";
import { isPro, setProUnlocked } from "./pro";

/**
 * Must EXACTLY match the in-app product id created in the Play Console
 * (Monetize → Products → In-app products). One-time, non-consumable, ACTIVE.
 */
export const PRO_PRODUCT_ID = "pdfeditor_pro";

// CdvPurchase is a runtime global injected by the Cordova plugin under Capacitor. Typed loosely on
// purpose — pulling its ambient types into a static-export build is more trouble than it's worth.
type Cdv = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type CdvStore = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let store: CdvStore | null = null;
let initPromise: Promise<CdvStore | null> | null = null;
let onEntitlementChange: (() => void) | null = null;

const getCdv = (): Cdv | null => (globalThis as { CdvPurchase?: Cdv }).CdvPurchase ?? null;

/** Wait for the Cordova plugin's global to appear (it's injected at WebView load on native). */
async function waitForCdv(timeoutMs = 4000): Promise<Cdv | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = getCdv();
    if (c?.store) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  return getCdv();
}

/** Grant Pro if the store reports the product as owned. Never revokes (conservative on purpose). */
function reflectOwnership(s: CdvStore) {
  try {
    if (s.owned(PRO_PRODUCT_ID) && !isPro()) {
      setProUnlocked(true);
      onEntitlementChange?.();
    }
  } catch {
    /* store not ready / unknown product — ignore */
  }
}

/** Lazily connect to the store, register the product, wire listeners, and query existing purchases. */
async function ensureStore(): Promise<CdvStore | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (store) return store;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const Cdv = await waitForCdv();
    if (!Cdv?.store) {
      console.warn("CdvPurchase global not available — billing disabled.");
      return null;
    }
    const s: CdvStore = Cdv.store;
    s.verbosity = Cdv.LogLevel.WARNING;

    s.register([
      {
        id: PRO_PRODUCT_ID,
        type: Cdv.ProductType.NON_CONSUMABLE,
        platform: Cdv.Platform.GOOGLE_PLAY,
      },
    ]);

    s.when()
      .productUpdated(() => reflectOwnership(s))
      // No server receipt validation for a one-time unlock — approve → finish locally.
      .approved((t: CdvStore) => t.finish())
      .finished(() => reflectOwnership(s));

    s.error((e: { code?: unknown; message?: string }) =>
      console.warn("Billing error:", e?.code, e?.message),
    );

    // initialize() connects to Play Billing and pulls down already-owned purchases.
    await s.initialize([Cdv.Platform.GOOGLE_PLAY]);
    reflectOwnership(s);
    store = s;
    return s;
  })();

  return initPromise;
}

/**
 * Call once on app startup (native only). `onChange` fires when the entitlement flips (e.g. Play
 * auto-restores a past purchase on launch) so the UI can re-read isPro().
 */
export async function initBilling(onChange?: () => void): Promise<void> {
  onEntitlementChange = onChange ?? null;
  await ensureStore();
}

/** Start the one-time purchase. Returns true if Pro is unlocked, false if the user cancelled. */
export async function purchasePro(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    // No billing rail on the web build — unlock locally so the web app stays usable.
    setProUnlocked(true);
    return true;
  }
  const s = await ensureStore();
  const Cdv = getCdv();
  if (!s || !Cdv) throw new Error("Store is unavailable. Please try again.");

  const product = s.get(PRO_PRODUCT_ID, Cdv.Platform.GOOGLE_PLAY);
  const offer = product?.getOffer?.();
  if (!offer) throw new Error("Pro isn’t available yet. Check your connection and try again.");

  // order() resolves with an IError on failure/cancel (it does not throw).
  const err = await s.order(offer);
  if (err) {
    if (err.code === Cdv.ErrorCode?.PAYMENT_CANCELLED) return false;
    throw new Error(err.message || "Purchase failed. Please try again.");
  }
  reflectOwnership(s);
  return isPro();
}

/** Restore a previous one-time purchase. Returns true if Pro is (now) owned. */
export async function restorePro(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    setProUnlocked(true);
    return true;
  }
  const s = await ensureStore();
  if (!s) throw new Error("Store is unavailable. Please try again.");

  await s.restorePurchases();
  reflectOwnership(s);
  return isPro();
}

/** Localized store price (e.g. "₺59,99") once the product has loaded, else null. */
export function getProPrice(): string | null {
  try {
    const Cdv = getCdv();
    const offer = store?.get(PRO_PRODUCT_ID, Cdv?.Platform?.GOOGLE_PLAY)?.getOffer?.();
    return offer?.pricingPhases?.[0]?.price ?? null;
  } catch {
    return null;
  }
}

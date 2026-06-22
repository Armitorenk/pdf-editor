"use client";

// A single, non-intrusive bottom banner shown only to free users on the Android app. The AdMob
// banner is a NATIVE overlay anchored to the bottom of the screen; this component also renders a
// matching reserved strip in the flex layout so the overlay never covers app content. Pro users
// and the web build render nothing and show no ad.
//
// Real AdMob app + banner ids are wired in (manifest App ID + BANNER_UNIT below). While
// AD_TESTING is true the SDK serves TEST ads regardless of the unit, so you never risk tapping
// your own live ads. Flip AD_TESTING to false for the production/release build so real users get
// real (revenue) ads — and never tap ads yourself on a non-test device.

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

const BANNER_UNIT = "ca-app-pub-7701018764928268/5710436338"; // real AdMob banner unit
const AD_TESTING = true; // ⚠️ set to false for the production/release build to serve real ads
const BANNER_H = 56; // ~50dp standard banner + a little breathing room

export function AdBanner({ show }: { show: boolean }) {
  useEffect(() => {
    if (!show || !Capacitor.isNativePlatform()) return;
    let active = true;
    void (async () => {
      try {
        const { AdMob, BannerAdPosition, BannerAdSize } = await import("@capacitor-community/admob");
        await AdMob.initialize();
        if (!active) return;
        await AdMob.showBanner({
          adId: BANNER_UNIT,
          adSize: BannerAdSize.BANNER,
          position: BannerAdPosition.BOTTOM_CENTER,
          margin: 0,
          isTesting: AD_TESTING,
        });
      } catch (e) {
        // No ad is never fatal — the reserved strip just stays empty.
        console.warn("AdMob banner unavailable:", e);
      }
    })();
    return () => {
      active = false;
      void (async () => {
        try {
          const { AdMob } = await import("@capacitor-community/admob");
          await AdMob.removeBanner();
        } catch {
          /* ignore */
        }
      })();
    };
  }, [show]);

  if (!show) return null;
  // Reserve the bottom strip so the native banner overlay sits over empty space, not content.
  return (
    <div
      aria-hidden
      className="shrink-0 border-t border-neutral-200 bg-neutral-100"
      style={{ height: `calc(${BANNER_H}px + env(safe-area-inset-bottom))` }}
    />
  );
}

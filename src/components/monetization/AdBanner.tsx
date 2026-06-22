"use client";

// A single, non-intrusive bottom banner shown only to free users on the Android app. The AdMob
// banner is a NATIVE overlay anchored to the bottom of the screen; this component also renders a
// matching reserved strip in the flex layout so the overlay never covers app content. Pro users
// and the web build render nothing and show no ad.
//
// Uses Google's official TEST ad unit + the test App ID in AndroidManifest, so it's safe to ship
// during development. Swap in the real AdMob App ID (manifest) + ad unit id (TODO below) before
// release — and only then will it earn.

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

// Google's public TEST banner ad unit (always fills, never bills). Replace with your real unit id.
const TEST_BANNER_UNIT = "ca-app-pub-3940256099942544/6300978111";
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
          adId: TEST_BANNER_UNIT, // TODO(release): your real AdMob banner unit id
          adSize: BannerAdSize.BANNER,
          position: BannerAdPosition.BOTTOM_CENTER,
          margin: 0,
          isTesting: true,
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

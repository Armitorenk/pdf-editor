import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: the app is 100% client-side, so it ships as plain HTML/JS with
  // no Node server. This is what lets Capacitor bundle it into the Android APK
  // (webDir = `out`), and it also means it can be hosted on any static host.
  output: "export",
  // Static export can't use the Next image-optimization server.
  images: { unoptimized: true },
};

export default nextConfig;

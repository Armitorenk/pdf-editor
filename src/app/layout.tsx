import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PDF Editor",
  description: "Edit PDFs entirely on your device — text, images, annotations, pages.",
  applicationName: "PDF Editor",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "PDF Editor" },
};

// Lock the webview so the app shell can't be pinch-zoomed or rubber-banded; the
// document viewer does its own zoom. `viewportFit: cover` lets us paint under
// notches and use the safe-area insets. Tuned for the Android (Capacitor) app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col overscroll-none">{children}</body>
    </html>
  );
}

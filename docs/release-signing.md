# Release signing & AAB

The Play Store needs a **signed Android App Bundle (`.aab`)**, not the debug APK.

## How it's wired
`android/app/build.gradle` reads the signing secrets from **`android/keystore.properties`**, which is
**gitignored** (never committed). If that file is missing (CI, a fresh clone, debug-only work),
release signing is skipped and the build still works.

`android/keystore.properties` format:

```
storeFile=upload-keystore.jks
storePassword=YOUR_PASSWORD
keyAlias=upload
keyPassword=YOUR_PASSWORD
```

The keystore itself lives at `android/app/upload-keystore.jks` (also gitignored).

## ⚠️ Back this up
- **Save `upload-keystore.jks` + the password somewhere safe** (password manager / a backup drive).
- This is the **upload key**. With **Play App Signing** (on by default for new apps) it is *recoverable*:
  if you lose it, you can request an upload-key reset from Google — so it is not catastrophic, but
  keep it anyway.
- Do NOT commit the keystore or `keystore.properties`.

## Regenerate the keystore (if ever needed)
```
keytool -genkeypair -v -keystore android/app/upload-keystore.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Armitor Apps, O=Armitor Apps, C=TR"
```
(The certificate `CN/O` is cosmetic — it need NOT match the Play developer name and is not shown to users.)

## Build the AAB
```
# from android/, with JDK 21 + ANDROID_HOME set
./gradlew bundleRelease
```
Output: `android/app/build/outputs/bundle/release/app-release.aab` → upload this to Play.

## Before the production/release build
- In `src/components/monetization/AdBanner.tsx`, set `AD_TESTING = false` so real (revenue) ads serve.
- Bump `versionCode` / `versionName` in `android/app/build.gradle` for each new upload.

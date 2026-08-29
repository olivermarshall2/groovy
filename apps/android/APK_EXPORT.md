# Android APK Export Options

Use these commands from the repository root to build sideloadable Android artifacts for testing.

## Option 1: Debug APK

Best for quick device installs during development.

```powershell
pnpm --filter @mp3-platform/android apk:debug
```

Output:

`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`

## Option 2: Release APK

Builds a release-mode APK. In the current project config this is still signed with the debug keystore, which is fine for internal sideload testing but not for store distribution.

```powershell
pnpm --filter @mp3-platform/android apk:release
```

Output:

`apps/android/android/app/build/outputs/apk/release/app-release.apk`

## Option 3: Release App Bundle

Useful if you later want a Play Store style artifact.

```powershell
pnpm --filter @mp3-platform/android apk:bundle
```

Output:

`apps/android/android/app/build/outputs/bundle/release/app-release.aab`

## Notes

- The Android package id is `com.mp3platform.android`.
- The current `release` build type uses the debug keystore in `android/app/build.gradle`.
- For public distribution, replace that with a proper signing config before shipping.

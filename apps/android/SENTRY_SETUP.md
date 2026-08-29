# Sentry Crash Reporting

This Android app is wired for Sentry crash reporting.

## What is already set up

- `@sentry/react-native` is installed.
- Sentry initializes at app startup in `App.tsx`.
- The root app component is wrapped with `Sentry.wrap(...)`.
- Expo Metro uses the Sentry Metro config in `metro.config.js`.
- The Expo plugin `@sentry/react-native/expo` is enabled in `app.json`.

## What you need to provide

Set a Sentry DSN before building:

```powershell
$env:EXPO_PUBLIC_SENTRY_DSN="https://YOUR_PUBLIC_KEY@o0.ingest.sentry.io/0"
```

Then rebuild the Android app or APK.

If `EXPO_PUBLIC_SENTRY_DSN` is not set, Sentry stays disabled and sends nothing.

## Optional: source maps and native debug symbols

For better symbolicated production crash reports, also configure:

- Sentry organization slug
- Sentry project slug
- `SENTRY_AUTH_TOKEN`

Those are not required just to start capturing crashes, but they improve the readability of release crash reports.

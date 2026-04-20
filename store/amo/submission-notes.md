# AMO Submission Notes

## Public listing fields

- Home page: `https://banana.rematrixed.com/`
- Privacy policy: `https://banana.rematrixed.com/privacy`
- Category: `other`

## Reviewer notes

This extension is designed for users who run their own Flow2API service.

- It reads cookies from `https://labs.google/` only.
- It looks for the `__Secure-next-auth.session-token` cookie only.
- During setup, the user enters a Flow2API address plus username and password once.
- That login is sent only to the user's own Flow2API server to obtain an internal plugin connection credential for later syncs; the password is not kept as the long-term runtime credential.
- The AMO listed package does not request install-time access to all websites. Its install-time host permission is limited to `https://labs.google/*`; access to the user-entered Flow2API origin is requested at runtime through optional host permissions only when the user connects a site.
- If the browser still has a reusable Google login but the related page is not open, the extension may silently open `https://labs.google/` in a background tab to rediscover that session, then close the temporary tab.
- Before overwriting the user's current Flow2API token, the extension attempts to validate the candidate Labs session through the user's own Flow2API endpoint and ignores stale Labs cookies whose browser `expirationDate` may be misleadingly long.
- If the extension cannot validate a newly discovered Labs cookie yet but the currently synced token is still known to be valid, it keeps the current token and schedules a retry instead of overwriting it blindly.
- The extracted token is sent only to the user's own Flow2API endpoint at `/api/plugin/update-token`.
- The extension remembers the last successful Labs cookie context for the current profile and prefers that same cookie store / container during later background recovery, to avoid mixing sessions inside one Firefox-based profile.
- The extension does not send analytics, ads, telemetry, or tracking data to the developer.
- Local per-profile sync state is stored in `storage.local`.
- Flow2API address and the discovered internal plugin connection credential are kept per-profile in `storage.local`; the add-on does not rely on `storage.sync`.

## Build and sign

Build the AMO upload package:

```bash
./scripts/build_amo_submission.sh
```

Submit a listed AMO signing request:

```bash
export AMO_API_KEY='your-amo-jwt-issuer'
export AMO_API_SECRET='your-amo-jwt-secret'
export AMO_LISTED_ENABLED=1
./scripts/sign_amo_listed.sh
```

This listed release script talks to the AMO V5 API directly instead of relying on `web-ext sign`, because the direct API flow has been more reliable for this add-on. The listed build is created with `AMO_LISTED_REVIEW_MODE=1`, which narrows install-time host permissions and moves Flow2API site access to runtime optional host permissions.
It also patches the top-level AMO listing metadata and privacy policy from `store/amo/metadata.listed.json` and `store/amo/eula-policy.json` before deciding whether a new listed version needs to be created.
During the current testing phase, listed AMO publishing is disabled by default; you must opt in with `AMO_LISTED_ENABLED=1`.

Submit an unlisted AMO signing request for self-distribution and download the signed auto-update XPI:

```bash
export AMO_API_KEY='your-amo-jwt-issuer'
export AMO_API_SECRET='your-amo-jwt-secret'
export FLOW2API_PUBLIC_BASE_URL='https://banana.rematrixed.com'
./scripts/sign_amo_unlisted.sh
```

This unlisted release script builds a Gecko package with `browser_specific_settings.gecko.update_url`, submits it through the AMO V5 API, waits until the signed file becomes public in the unlisted channel, and downloads the signed XPI back into `dist/firefox/`.

# AMO Submission Notes

## Public listing fields

- Home page: `https://banana.rematrixed.com/`
- Privacy policy: `https://banana.rematrixed.com/privacy`
- Category: `other`

## Reviewer notes

This extension is designed for users who run their own Flow2API service.

- It reads cookies from `https://labs.google/` only.
- It looks for the `__Secure-next-auth.session-token` cookie only.
- After the user enters a Flow2API address and grants site access, the extension may read the local admin session state from the user's already logged-in Flow2API console in the same browser in order to auto-discover the plugin connection token.
- If the browser still has a reusable login but the related page is not open, the extension may silently open `https://labs.google/` or the user's Flow2API `/manage` page in a background tab to rediscover that session, then close the temporary tab.
- The extracted token is sent only to the user's own Flow2API endpoint at `/api/plugin/update-token`.
- The extension remembers the last successful Labs cookie context for the current profile and prefers that same cookie store / container during later background recovery, to avoid mixing sessions inside one Firefox-based profile.
- If the previously discovered plugin connection token is rejected but the browser still has a reusable Flow2API console login, the extension may silently reopen the user's own `/manage` page in a background tab, rediscover the plugin connection token, and retry exactly once.
- The extension does not send analytics, ads, telemetry, or tracking data to the developer.
- Local per-profile sync state is stored in `storage.local`.
- Flow2API address and discovered plugin connection token are now also kept per-profile in `storage.local`; the add-on no longer shares them through `storage.sync`.

## Build and sign

Build the AMO upload package:

```bash
./scripts/build_amo_submission.sh
```

Submit a listed AMO signing request:

```bash
export AMO_API_KEY='your-amo-jwt-issuer'
export AMO_API_SECRET='your-amo-jwt-secret'
./scripts/sign_amo_listed.sh
```

This listed release script talks to the AMO V5 API directly instead of relying on `web-ext sign`, because the direct API flow has been more reliable for this add-on.

Submit an unlisted AMO signing request for self-distribution and download the signed auto-update XPI:

```bash
export AMO_API_KEY='your-amo-jwt-issuer'
export AMO_API_SECRET='your-amo-jwt-secret'
export FLOW2API_PUBLIC_BASE_URL='https://banana.rematrixed.com'
./scripts/sign_amo_unlisted.sh
```

This unlisted release script builds a Gecko package with `browser_specific_settings.gecko.update_url`, submits it through the AMO V5 API, waits until the signed file becomes public in the unlisted channel, and downloads the signed XPI back into `dist/firefox/`.

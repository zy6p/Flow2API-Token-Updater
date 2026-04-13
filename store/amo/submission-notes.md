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
- The extracted token is sent only to the user's own Flow2API endpoint at `/api/plugin/update-token`.
- The extension does not send analytics, ads, telemetry, or tracking data to the developer.
- Sensitive `connectionToken` values are stored in `storage.local` only.
- Local per-profile sync state is stored in `storage.local`.
- When browser sync storage is available, the Flow2API address and discovered plugin connection token may also be stored in `storage.sync` so the user's other browser profiles under the same browser account can reuse the Flow2API connection setup.

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

Submit an unlisted AMO signing request for self-distribution:

```bash
export AMO_API_KEY='your-amo-jwt-issuer'
export AMO_API_SECRET='your-amo-jwt-secret'
./scripts/sign_amo_unlisted.sh
```

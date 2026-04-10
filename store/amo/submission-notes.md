# AMO Submission Notes

## Public listing fields

- Home page: `https://banana.rematrixed.com/`
- Privacy policy: `https://banana.rematrixed.com/privacy`
- Category: `other`

## Reviewer notes

This extension is designed for users who run their own Flow2API service.

- It reads cookies from `https://labs.google/` only.
- It looks for the `__Secure-next-auth.session-token` cookie only.
- The extracted token is sent only to the API URL configured by the user in the popup UI.
- The extension does not send analytics, ads, telemetry, or tracking data to the developer.
- Sensitive `connectionToken` values are stored in `storage.local` only.
- Non-sensitive settings such as account name, API URL, refresh interval, and cookie store mapping are stored in `storage.sync`.

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

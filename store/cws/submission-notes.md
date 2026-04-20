# Chrome Web Store Submission Notes

## Current flow

- Normal user setup is now `Flow2API site + username + password` only.
- The extension does not expose `connection_token` in the popup anymore.
- After the first successful Flow2API login, setup collapses and the popup becomes a simple sync surface.
- Opening the popup automatically syncs the current store/profile when Flow2API is already connected.

## Data handling

- The extension reads the `__Secure-next-auth.session-token` cookie from `https://labs.google/`.
- The extracted Google Labs session is sent only to the user-entered Flow2API origin.
- Flow2API username/password is used only during setup to obtain the plugin connection credential; the password is not kept as the long-term runtime credential.
- Local sync state, recent session context, and logs remain in browser local storage.

## Chrome Web Store automation

The repository now supports both Chrome Web Store API paths:

- Existing item update via API v2:
  - upload
  - fetchStatus
  - publish
- First item creation via API v1 `insert`

### Required credentials

Provide either environment variables or a local `.chrome-web-store-credentials.txt` file with:

```bash
export CWS_CLIENT_ID='...'
export CWS_CLIENT_SECRET='...'
export CWS_REFRESH_TOKEN='...'
export CWS_PUBLISHER_ID='...'
export CWS_EXTENSION_ID='...'
```

For first-time insertion, `CWS_EXTENSION_ID` is optional until the API returns a new item id.

### Existing item update

```bash
./scripts/sign_cws.sh
```

### First item insert

```bash
CWS_MODE=insert CWS_PUBLISH_AFTER_UPLOAD=0 ./scripts/sign_cws.sh
```

That creates the draft item and returns the Chrome Web Store item id, after which the listing/privacy fields can be completed in the dashboard before the first publish.

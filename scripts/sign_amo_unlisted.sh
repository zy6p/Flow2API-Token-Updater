#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS_DIR="${ROOT_DIR}/web-ext-artifacts"

if [[ -z "${AMO_API_KEY:-}" || -z "${AMO_API_SECRET:-}" ]]; then
  echo "AMO_API_KEY and AMO_API_SECRET are required." >&2
  exit 1
fi

npx --yes web-ext sign \
  --source-dir "${ROOT_DIR}" \
  --artifacts-dir "${ARTIFACTS_DIR}" \
  --channel unlisted \
  --api-key "${AMO_API_KEY}" \
  --api-secret "${AMO_API_SECRET}" \
  --approval-timeout 0 \
  --ignore-files ".git/**" ".github/**" ".cloudflare-pages" ".cloudflare-pages/**" "cloudflare-pages" "cloudflare-pages/**" "dist" "dist/**" "scripts" "scripts/**" "store" "store/**" "web-ext-artifacts" "web-ext-artifacts/**" ".wrangler" ".wrangler/**" ".gitignore" "readme.md" "image.png" "image-1.png" "image-2.png" "image-3.png"

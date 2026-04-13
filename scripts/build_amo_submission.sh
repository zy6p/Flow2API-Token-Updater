#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS_DIR="${ROOT_DIR}/web-ext-artifacts"
VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
PACKAGE_NAME="flow2api-token-updater-amo-${VERSION}.zip"
SOURCE_NAME="flow2api-token-updater-source-${VERSION}.tar.gz"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

IGNORE_FILES=(
  ".git/**"
  ".github/**"
  ".cloudflare-pages"
  ".cloudflare-pages/**"
  "cloudflare-pages"
  "cloudflare-pages/**"
  "dist"
  "dist/**"
  "scripts"
  "scripts/**"
  "store"
  "store/**"
  "web-ext-artifacts"
  "web-ext-artifacts/**"
  ".wrangler"
  ".wrangler/**"
  ".gitignore"
  "readme.md"
  "image.png"
  "image-1.png"
  "image-2.png"
  "image-3.png"
)
IGNORE_ARGS=()

for pattern in "${IGNORE_FILES[@]}"; do
  IGNORE_ARGS+=("--ignore-files=${pattern}")
done

mkdir -p "${ARTIFACTS_DIR}"
"${ROOT_DIR}/scripts/prepare_gecko_source.sh" "${STAGE_DIR}"

npx --yes web-ext build \
  --source-dir "${STAGE_DIR}" \
  --artifacts-dir "${ARTIFACTS_DIR}" \
  --filename "${PACKAGE_NAME}" \
  --overwrite-dest \
  --ignore-files "INSTALL.txt" \
  "${IGNORE_ARGS[@]}"

tar -C "${ROOT_DIR}" \
  --exclude-vcs \
  --exclude=".cloudflare-pages" \
  --exclude="cloudflare-pages" \
  --exclude="dist" \
  --exclude="web-ext-artifacts" \
  --exclude=".wrangler" \
  -czf "${ARTIFACTS_DIR}/${SOURCE_NAME}" \
  .

printf 'AMO package: %s\n' "${ARTIFACTS_DIR}/${PACKAGE_NAME}"
printf 'Source archive: %s\n' "${ARTIFACTS_DIR}/${SOURCE_NAME}"

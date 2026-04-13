#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.cloudflare-pages"
FIREFOX_DIR="${ROOT_DIR}/dist/firefox"
CHROMIUM_DIR="${ROOT_DIR}/dist/chromium"

VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"

"${ROOT_DIR}/scripts/build_gecko_temp_bundle.sh"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/downloads"

cp "${ROOT_DIR}/cloudflare-pages/index.html" "${OUT_DIR}/index.html"
cp "${ROOT_DIR}/privacy.html" "${OUT_DIR}/privacy.html"

if [[ -f "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.xpi" ]]; then
  cp "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.xpi" "${OUT_DIR}/downloads/latest-firefox.xpi"
fi

if [[ -f "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.zip" ]]; then
  cp "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.zip" "${OUT_DIR}/downloads/latest-firefox.zip"
fi

cp "${FIREFOX_DIR}/flow2api_token_updater-gecko-temp-${VERSION}.zip" "${OUT_DIR}/downloads/latest-gecko-temporary.zip"
cp "${CHROMIUM_DIR}/Flow2API-Token-Updater-chromium.zip" "${OUT_DIR}/downloads/latest-chromium.zip"

printf 'Cloudflare Pages assets prepared at %s\n' "${OUT_DIR}"

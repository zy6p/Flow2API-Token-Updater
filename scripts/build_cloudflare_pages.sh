#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.cloudflare-pages"
FIREFOX_DIR="${ROOT_DIR}/dist/firefox"
CHROMIUM_DIR="${ROOT_DIR}/dist/chromium"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/downloads"

cp "${ROOT_DIR}/cloudflare-pages/index.html" "${OUT_DIR}/index.html"
cp "${ROOT_DIR}/privacy.html" "${OUT_DIR}/privacy.html"

cp "${FIREFOX_DIR}/flow2api_token_updater-1.0.0.xpi" "${OUT_DIR}/downloads/latest-firefox.xpi"
cp "${FIREFOX_DIR}/flow2api_token_updater-1.0.0.zip" "${OUT_DIR}/downloads/latest-firefox.zip"
cp "${CHROMIUM_DIR}/Flow2API-Token-Updater-chromium.zip" "${OUT_DIR}/downloads/latest-chromium.zip"

printf 'Cloudflare Pages assets prepared at %s\n' "${OUT_DIR}"

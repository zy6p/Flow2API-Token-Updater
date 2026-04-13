#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.cloudflare-pages"
FIREFOX_DIR="${ROOT_DIR}/dist/firefox"
CHROMIUM_DIR="${ROOT_DIR}/dist/chromium"

VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
BUILD_DATE="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
GECKO_TEMP_FILE="flow2api_token_updater-gecko-temp-${VERSION}.zip"
CHROMIUM_VERSIONED_FILE="Flow2API-Token-Updater-chromium-${VERSION}.zip"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

"${ROOT_DIR}/scripts/build_gecko_temp_bundle.sh"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/downloads"

cp "${ROOT_DIR}/privacy.html" "${OUT_DIR}/privacy.html"

if [[ -f "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.xpi" ]]; then
  cp "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.xpi" "${OUT_DIR}/downloads/latest-firefox.xpi"
fi

if [[ -f "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.zip" ]]; then
  cp "${FIREFOX_DIR}/flow2api_token_updater-${VERSION}.zip" "${OUT_DIR}/downloads/latest-firefox.zip"
fi

cp "${FIREFOX_DIR}/${GECKO_TEMP_FILE}" "${OUT_DIR}/downloads/latest-gecko-temporary.zip"
cp "${FIREFOX_DIR}/${GECKO_TEMP_FILE}" "${OUT_DIR}/downloads/${GECKO_TEMP_FILE}"
cp "${CHROMIUM_DIR}/Flow2API-Token-Updater-chromium.zip" "${OUT_DIR}/downloads/latest-chromium.zip"
cp "${CHROMIUM_DIR}/Flow2API-Token-Updater-chromium.zip" "${OUT_DIR}/downloads/${CHROMIUM_VERSIONED_FILE}"

GECKO_SHA256="$(hash_file "${OUT_DIR}/downloads/${GECKO_TEMP_FILE}")"
CHROMIUM_SHA256="$(hash_file "${OUT_DIR}/downloads/${CHROMIUM_VERSIONED_FILE}")"

cat > "${OUT_DIR}/downloads/latest.json" <<EOF
{
  "version": "${VERSION}",
  "built_at": "${BUILD_DATE}",
  "artifacts": {
    "gecko_temporary": {
      "latest_url": "/downloads/latest-gecko-temporary.zip",
      "versioned_url": "/downloads/${GECKO_TEMP_FILE}",
      "filename": "${GECKO_TEMP_FILE}",
      "sha256": "${GECKO_SHA256}"
    },
    "chromium": {
      "latest_url": "/downloads/latest-chromium.zip",
      "versioned_url": "/downloads/${CHROMIUM_VERSIONED_FILE}",
      "filename": "${CHROMIUM_VERSIONED_FILE}",
      "sha256": "${CHROMIUM_SHA256}"
    }
  }
}
EOF

cat > "${OUT_DIR}/downloads/SHA256SUMS" <<EOF
${GECKO_SHA256}  ${GECKO_TEMP_FILE}
${CHROMIUM_SHA256}  ${CHROMIUM_VERSIONED_FILE}
EOF

ROOT_DIR="${ROOT_DIR}" OUT_DIR="${OUT_DIR}" VERSION="${VERSION}" BUILD_DATE="${BUILD_DATE}" GECKO_TEMP_FILE="${GECKO_TEMP_FILE}" CHROMIUM_VERSIONED_FILE="${CHROMIUM_VERSIONED_FILE}" node <<'EOF'
const fs = require('fs');
const path = require('path');

const templatePath = path.join(process.env.ROOT_DIR, 'cloudflare-pages', 'index.html');
const outputPath = path.join(process.env.OUT_DIR, 'index.html');

let html = fs.readFileSync(templatePath, 'utf8');
const replacements = {
  '__FLOW2API_VERSION__': process.env.VERSION,
  '__FLOW2API_BUILD_DATE__': process.env.BUILD_DATE,
  '__FLOW2API_GECKO_VERSIONED_FILE__': process.env.GECKO_TEMP_FILE,
  '__FLOW2API_CHROMIUM_VERSIONED_FILE__': process.env.CHROMIUM_VERSIONED_FILE
};

for (const [needle, value] of Object.entries(replacements)) {
  html = html.split(needle).join(value);
}

fs.writeFileSync(outputPath, html);
EOF

printf 'Cloudflare Pages assets prepared at %s\n' "${OUT_DIR}"

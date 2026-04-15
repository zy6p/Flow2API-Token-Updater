#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/.cloudflare-pages"
FIREFOX_DIR="${ROOT_DIR}/dist/firefox"
CHROMIUM_DIR="${ROOT_DIR}/dist/chromium"
PUBLIC_BASE_URL="${FLOW2API_PUBLIC_BASE_URL:-https://banana.rematrixed.com}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
SELFHOST_VERSION="${FLOW2API_GECKO_SELFHOST_VERSION:-${VERSION}.2}"
BUILD_DATE="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
GECKO_TEMP_FILE="flow2api_token_updater-gecko-temp-${VERSION}.zip"
GECKO_RELEASE_ZIP="flow2api_token_updater-${VERSION}.zip"
GECKO_RELEASE_XPI="flow2api_token_updater-${VERSION}.xpi"
GECKO_SELFHOST_XPI="flow2api_token_updater-selfhost-${SELFHOST_VERSION}.xpi"
CHROMIUM_VERSIONED_FILE="Flow2API-Token-Updater-chromium-${VERSION}.zip"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

"${ROOT_DIR}/scripts/build_gecko_temp_bundle.sh"
"${ROOT_DIR}/scripts/build_gecko_release_bundle.sh"
"${ROOT_DIR}/scripts/build_chromium_bundle.sh"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/downloads"

cp "${ROOT_DIR}/privacy.html" "${OUT_DIR}/privacy.html"
cp "${ROOT_DIR}/cloudflare-pages/_headers" "${OUT_DIR}/_headers"

if [[ -f "${FIREFOX_DIR}/${GECKO_RELEASE_XPI}" ]]; then
  cp "${FIREFOX_DIR}/${GECKO_RELEASE_XPI}" "${OUT_DIR}/downloads/latest-firefox.xpi"
  cp "${FIREFOX_DIR}/${GECKO_RELEASE_XPI}" "${OUT_DIR}/downloads/${GECKO_RELEASE_XPI}"
fi

if [[ -f "${FIREFOX_DIR}/${GECKO_RELEASE_ZIP}" ]]; then
  cp "${FIREFOX_DIR}/${GECKO_RELEASE_ZIP}" "${OUT_DIR}/downloads/latest-firefox.zip"
  cp "${FIREFOX_DIR}/${GECKO_RELEASE_ZIP}" "${OUT_DIR}/downloads/${GECKO_RELEASE_ZIP}"
fi

cp "${FIREFOX_DIR}/${GECKO_TEMP_FILE}" "${OUT_DIR}/downloads/latest-gecko-temporary.zip"
cp "${FIREFOX_DIR}/${GECKO_TEMP_FILE}" "${OUT_DIR}/downloads/${GECKO_TEMP_FILE}"
cp "${CHROMIUM_DIR}/${CHROMIUM_VERSIONED_FILE}" "${OUT_DIR}/downloads/latest-chromium.zip"
cp "${CHROMIUM_DIR}/${CHROMIUM_VERSIONED_FILE}" "${OUT_DIR}/downloads/${CHROMIUM_VERSIONED_FILE}"

GECKO_SHA256="$(hash_file "${OUT_DIR}/downloads/${GECKO_TEMP_FILE}")"
CHROMIUM_SHA256="$(hash_file "${OUT_DIR}/downloads/${CHROMIUM_VERSIONED_FILE}")"

GECKO_SELFHOST_SHA256=""
GECKO_SELFHOST_UPDATE_URL=""
if [[ -f "${FIREFOX_DIR}/${GECKO_SELFHOST_XPI}" ]]; then
  cp "${FIREFOX_DIR}/${GECKO_SELFHOST_XPI}" "${OUT_DIR}/downloads/latest-firefox-selfhost.xpi"
  cp "${FIREFOX_DIR}/${GECKO_SELFHOST_XPI}" "${OUT_DIR}/downloads/${GECKO_SELFHOST_XPI}"
  GECKO_SELFHOST_SHA256="$(hash_file "${OUT_DIR}/downloads/${GECKO_SELFHOST_XPI}")"
  GECKO_SELFHOST_UPDATE_URL="${PUBLIC_BASE_URL}/downloads/updates.json"
fi

ROOT_DIR="${ROOT_DIR}" BUILD_DATE="${BUILD_DATE}" GECKO_TEMP_FILE="${GECKO_TEMP_FILE}" CHROMIUM_VERSIONED_FILE="${CHROMIUM_VERSIONED_FILE}" GECKO_SHA256="${GECKO_SHA256}" CHROMIUM_SHA256="${CHROMIUM_SHA256}" GECKO_SELFHOST_XPI="${GECKO_SELFHOST_XPI}" GECKO_SELFHOST_SHA256="${GECKO_SELFHOST_SHA256}" GECKO_SELFHOST_UPDATE_URL="${GECKO_SELFHOST_UPDATE_URL}" SELFHOST_VERSION="${SELFHOST_VERSION}" node <<'EOF' > "${OUT_DIR}/downloads/latest.json"
const fs = require('fs');
const path = require('path');

const rootDir = process.env.ROOT_DIR;
const manifest = require(path.join(rootDir, 'manifest.json'));
const version = manifest.version;
const buildDate = process.env.BUILD_DATE;
const geckoTempFile = process.env.GECKO_TEMP_FILE;
const chromiumFile = process.env.CHROMIUM_VERSIONED_FILE;
const geckoSha = process.env.GECKO_SHA256;
const chromiumSha = process.env.CHROMIUM_SHA256;
const geckoSelfhostFile = process.env.GECKO_SELFHOST_XPI;
const geckoSelfhostSha = process.env.GECKO_SELFHOST_SHA256;
const geckoSelfhostUpdateUrl = process.env.GECKO_SELFHOST_UPDATE_URL;
const geckoSelfhostVersionMatch = (geckoSelfhostFile || '').match(/selfhost-(.+)\.xpi$/);
const geckoSelfhostVersion = geckoSelfhostVersionMatch ? geckoSelfhostVersionMatch[1] : (process.env.SELFHOST_VERSION || '');

const payload = {
  version,
  built_at: buildDate,
  artifacts: {
    gecko_temporary: {
      latest_url: '/downloads/latest-gecko-temporary.zip',
      versioned_url: `/downloads/${geckoTempFile}`,
      filename: geckoTempFile,
      sha256: geckoSha
    },
    chromium: {
      latest_url: '/downloads/latest-chromium.zip',
      versioned_url: `/downloads/${chromiumFile}`,
      filename: chromiumFile,
      sha256: chromiumSha
    }
  }
};

if (geckoSelfhostSha) {
  payload.artifacts.gecko_selfhost = {
    version: geckoSelfhostVersion,
    latest_url: '/downloads/latest-firefox-selfhost.xpi',
    versioned_url: `/downloads/${geckoSelfhostFile}`,
    filename: geckoSelfhostFile,
    sha256: geckoSelfhostSha,
    updates_url: geckoSelfhostUpdateUrl
  };
}

process.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
EOF

ROOT_DIR="${ROOT_DIR}" PUBLIC_BASE_URL="${PUBLIC_BASE_URL}" FIREFOX_DIR="${FIREFOX_DIR}" GECKO_SELFHOST_XPI="${GECKO_SELFHOST_XPI}" GECKO_SELFHOST_SHA256="${GECKO_SELFHOST_SHA256}" SELFHOST_VERSION="${SELFHOST_VERSION}" node <<'EOF'
const fs = require('fs');
const path = require('path');

const rootDir = process.env.ROOT_DIR;
const publicBaseUrl = `${process.env.PUBLIC_BASE_URL || ''}`.replace(/\/$/, '');
const selfhostXpi = `${process.env.GECKO_SELFHOST_XPI || ''}`.trim();
const selfhostSha = `${process.env.GECKO_SELFHOST_SHA256 || ''}`.trim();

if (!selfhostXpi || !selfhostSha) {
  process.exit(0);
}

const manifest = require(path.join(rootDir, 'manifest.json'));
const gecko = (((manifest.browser_specific_settings || {}).gecko) || {});
const addonId = gecko.id;
if (!addonId) {
  throw new Error('manifest browser_specific_settings.gecko.id is required for updates.json');
}

const updateManifest = {
  addons: {
    [addonId]: {
      updates: [
        {
          version: (((selfhostXpi || '').match(/selfhost-(.+)\.xpi$/) || [])[1]) || process.env.SELFHOST_VERSION || manifest.version,
          update_link: `${publicBaseUrl}/downloads/${selfhostXpi}`,
          update_hash: `sha256:${selfhostSha}`,
          update_info_url: `${publicBaseUrl}/`
        }
      ]
    }
  }
};

const outPath = path.join(rootDir, '.cloudflare-pages', 'downloads', 'updates.json');
fs.writeFileSync(outPath, `${JSON.stringify(updateManifest, null, 2)}
`);
EOF

cat > "${OUT_DIR}/downloads/SHA256SUMS" <<EOF
${GECKO_SHA256}  ${GECKO_TEMP_FILE}
${CHROMIUM_SHA256}  ${CHROMIUM_VERSIONED_FILE}
EOF

if [[ -n "${GECKO_SELFHOST_SHA256}" ]]; then
  printf '%s  %s
' "${GECKO_SELFHOST_SHA256}" "${GECKO_SELFHOST_XPI}" >> "${OUT_DIR}/downloads/SHA256SUMS"
fi

ROOT_DIR="${ROOT_DIR}" OUT_DIR="${OUT_DIR}" VERSION="${VERSION}" BUILD_DATE="${BUILD_DATE}" GECKO_TEMP_FILE="${GECKO_TEMP_FILE}" CHROMIUM_VERSIONED_FILE="${CHROMIUM_VERSIONED_FILE}" GECKO_SELFHOST_XPI="${GECKO_SELFHOST_XPI}" GECKO_SELFHOST_UPDATE_URL="${GECKO_SELFHOST_UPDATE_URL}" SELFHOST_VERSION="${SELFHOST_VERSION}" node <<'EOF'
const fs = require('fs');
const path = require('path');

const templatePath = path.join(process.env.ROOT_DIR, 'cloudflare-pages', 'index.html');
const outputPath = path.join(process.env.OUT_DIR, 'index.html');

let html = fs.readFileSync(templatePath, 'utf8');
const replacements = {
  '__FLOW2API_VERSION__': process.env.VERSION,
  '__FLOW2API_BUILD_DATE__': process.env.BUILD_DATE,
  '__FLOW2API_GECKO_VERSIONED_FILE__': process.env.GECKO_TEMP_FILE,
  '__FLOW2API_CHROMIUM_VERSIONED_FILE__': process.env.CHROMIUM_VERSIONED_FILE,
  '__FLOW2API_GECKO_SELFHOST_FILE__': process.env.GECKO_SELFHOST_XPI || '未生成',
  '__FLOW2API_GECKO_SELFHOST_VERSION__': process.env.SELFHOST_VERSION || '未生成',
  '__FLOW2API_GECKO_SELFHOST_UPDATES_URL__': process.env.GECKO_SELFHOST_UPDATE_URL || '需要先生成签名自更新包'
};

for (const [needle, value] of Object.entries(replacements)) {
  html = html.split(needle).join(value);
}

fs.writeFileSync(outputPath, html);
EOF

printf 'Cloudflare Pages assets prepared at %s
' "${OUT_DIR}"

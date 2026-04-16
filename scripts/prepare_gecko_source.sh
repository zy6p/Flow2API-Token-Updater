#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:?Usage: prepare_gecko_source.sh <target-dir>}"

mkdir -p "${TARGET_DIR}"

for path in   background.js   icon128.png   icon16.png   icon48.png   logs.html   logs.js   popup.html   popup.js   privacy.html
 do
  cp "${ROOT_DIR}/${path}" "${TARGET_DIR}/${path}"
 done

ROOT_DIR="${ROOT_DIR}" TARGET_DIR="${TARGET_DIR}" GECKO_UPDATE_URL="${GECKO_UPDATE_URL:-}" GECKO_VERSION_OVERRIDE="${GECKO_VERSION_OVERRIDE:-}" AMO_LISTED_REVIEW_MODE="${AMO_LISTED_REVIEW_MODE:-}" node <<'EOF'
const fs = require('fs');
const path = require('path');

const rootDir = process.env.ROOT_DIR;
const targetDir = process.env.TARGET_DIR;
const updateUrl = `${process.env.GECKO_UPDATE_URL || ''}`.trim();
const versionOverride = `${process.env.GECKO_VERSION_OVERRIDE || ''}`.trim();
const amoListedReviewMode = `${process.env.AMO_LISTED_REVIEW_MODE || ''}`.trim() === '1';
const manifestPath = path.join(rootDir, 'manifest.json');
const outputPath = path.join(targetDir, 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const background = { ...(manifest.background || {}) };
const gecko = {
  ...((manifest.browser_specific_settings && manifest.browser_specific_settings.gecko) || {})
};

delete background.service_worker;
background.scripts = ['background.js'];
manifest.background = background;

if (versionOverride) {
  manifest.version = versionOverride;
}

if (amoListedReviewMode) {
  manifest.host_permissions = ['https://labs.google/*'];
  manifest.optional_host_permissions = ['http://*/*', 'https://*/*'];
}

if (!manifest.browser_specific_settings || typeof manifest.browser_specific_settings !== 'object') {
  manifest.browser_specific_settings = {};
}

if (updateUrl) {
  gecko.update_url = updateUrl;
} else {
  delete gecko.update_url;
}

manifest.browser_specific_settings.gecko = gecko;

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}
`);
EOF

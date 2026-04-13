#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:?Usage: prepare_chromium_source.sh <target-dir>}"

mkdir -p "${TARGET_DIR}"

for path in \
  background.js \
  icon128.png \
  icon16.png \
  icon48.png \
  logs.html \
  logs.js \
  popup.html \
  popup.js \
  privacy.html
do
  cp "${ROOT_DIR}/${path}" "${TARGET_DIR}/${path}"
done

ROOT_DIR="${ROOT_DIR}" TARGET_DIR="${TARGET_DIR}" node <<'EOF'
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(process.env.ROOT_DIR, 'manifest.json');
const outputPath = path.join(process.env.TARGET_DIR, 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const background = { ...(manifest.background || {}) };

delete background.scripts;
background.service_worker = 'background.js';

manifest.background = background;

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
EOF

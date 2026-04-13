#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:?Usage: prepare_gecko_source.sh <target-dir>}"

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

const rootDir = process.env.ROOT_DIR;
const targetDir = process.env.TARGET_DIR;
const manifestPath = path.join(rootDir, 'manifest.json');
const outputPath = path.join(targetDir, 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const background = { ...(manifest.background || {}) };

delete background.service_worker;
background.scripts = ['background.js'];

manifest.background = background;

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
EOF

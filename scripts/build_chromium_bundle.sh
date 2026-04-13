#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMIUM_DIR="${ROOT_DIR}/dist/chromium"
VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
OUT_NAME="Flow2API-Token-Updater-chromium-${VERSION}.zip"
LEGACY_NAME="Flow2API-Token-Updater-chromium.zip"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

mkdir -p "${CHROMIUM_DIR}"
"${ROOT_DIR}/scripts/prepare_chromium_source.sh" "${STAGE_DIR}"

rm -f "${CHROMIUM_DIR}/${OUT_NAME}" "${CHROMIUM_DIR}/${LEGACY_NAME}"
(
  cd "${STAGE_DIR}"
  zip -qr "${CHROMIUM_DIR}/${OUT_NAME}" .
)

cp "${CHROMIUM_DIR}/${OUT_NAME}" "${CHROMIUM_DIR}/${LEGACY_NAME}"

printf 'Chromium bundle: %s\n' "${CHROMIUM_DIR}/${OUT_NAME}"

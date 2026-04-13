#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIREFOX_DIR="${ROOT_DIR}/dist/firefox"
VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
ZIP_NAME="flow2api_token_updater-${VERSION}.zip"
XPI_NAME="flow2api_token_updater-${VERSION}.xpi"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

mkdir -p "${FIREFOX_DIR}"
"${ROOT_DIR}/scripts/prepare_gecko_source.sh" "${STAGE_DIR}"

rm -f "${FIREFOX_DIR}/${ZIP_NAME}" "${FIREFOX_DIR}/${XPI_NAME}"
(
  cd "${STAGE_DIR}"
  zip -qr "${FIREFOX_DIR}/${ZIP_NAME}" .
)

cp "${FIREFOX_DIR}/${ZIP_NAME}" "${FIREFOX_DIR}/${XPI_NAME}"

printf 'Gecko release bundle: %s\n' "${FIREFOX_DIR}/${ZIP_NAME}"

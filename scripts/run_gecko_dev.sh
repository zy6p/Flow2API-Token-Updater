#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GECKO_BINARY="${GECKO_BINARY:-firefox}"
GECKO_PROFILE="${GECKO_PROFILE:-}"
HEADLESS="${HEADLESS:-0}"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

if ! command -v "${GECKO_BINARY}" >/dev/null 2>&1 && [[ ! -x "${GECKO_BINARY}" ]]; then
  echo "Cannot find Gecko browser binary: ${GECKO_BINARY}" >&2
  echo "Set GECKO_BINARY to the Zen/Firefox executable path, for example:" >&2
  echo "  GECKO_BINARY=/path/to/zen-browser ./scripts/run_gecko_dev.sh" >&2
  exit 1
fi

"${ROOT_DIR}/scripts/prepare_gecko_source.sh" "${STAGE_DIR}"

cmd=(
  npx --yes web-ext run
  --source-dir "${STAGE_DIR}"
  --firefox "${GECKO_BINARY}"
  --no-input
  --no-reload
)

if [[ -n "${GECKO_PROFILE}" ]]; then
  cmd+=(
    --firefox-profile "${GECKO_PROFILE}"
    --keep-profile-changes
  )
fi

if [[ "${HEADLESS}" == "1" ]]; then
  cmd+=(--arg=-headless)
fi

printf 'Running temporary Gecko add-on with %s\n' "${GECKO_BINARY}"
printf 'Using staged Gecko source %s\n' "${STAGE_DIR}"
if [[ -n "${GECKO_PROFILE}" ]]; then
  printf 'Using profile %s\n' "${GECKO_PROFILE}"
fi

exec "${cmd[@]}"

#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/scripts/build_chromium_bundle.sh"
node "${ROOT_DIR}/scripts/submit_cws.js"

#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/scripts/build_amo_submission.sh"
node "${ROOT_DIR}/scripts/submit_amo_listed.js"

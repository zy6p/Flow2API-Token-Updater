#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${AMO_LISTED_ENABLED:-0}" != "1" ]]; then
  echo "AMO listed release is disabled by default during testing. Set AMO_LISTED_ENABLED=1 to publish."
  exit 0
fi

"${ROOT_DIR}/scripts/build_amo_submission.sh"
node "${ROOT_DIR}/scripts/submit_amo_listed.js"

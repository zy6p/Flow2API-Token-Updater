#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${AMO_API_KEY:-}" || -z "${AMO_API_SECRET:-}" ]]; then
  echo "AMO_API_KEY and AMO_API_SECRET are required." >&2
  exit 1
fi

"${ROOT_DIR}/scripts/build_amo_submission.sh"
node "${ROOT_DIR}/scripts/submit_amo_listed.js"

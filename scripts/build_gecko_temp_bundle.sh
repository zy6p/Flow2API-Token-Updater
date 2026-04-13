#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIREFOX_DIR="${ROOT_DIR}/dist/firefox"
VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
OUT_NAME="flow2api_token_updater-gecko-temp-${VERSION}.zip"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

mkdir -p "${FIREFOX_DIR}"
"${ROOT_DIR}/scripts/prepare_gecko_source.sh" "${STAGE_DIR}"

cat > "${STAGE_DIR}/INSTALL.txt" <<'EOF'
Firefox / Zen 临时安装说明

1. 解压这个 ZIP。
2. 打开 about:debugging#/runtime/this-firefox
3. 点击 “Load Temporary Add-on / 临时加载附加组件”
4. 选择解压后目录里的 manifest.json

注意：
- 这是开发态临时加载，浏览器重启后需要重新加载。
- 这个包里的 manifest 已按 Gecko 兼容方式生成，不要直接加载仓库根目录的 manifest.json。
- 未签名的 .xpi 在 about:addons 中通常会显示“附加组件似乎已损坏”。
EOF

rm -f "${FIREFOX_DIR}/${OUT_NAME}"
(
  cd "${STAGE_DIR}"
  zip -qr "${FIREFOX_DIR}/${OUT_NAME}" .
)

printf 'Gecko temporary bundle: %s\n' "${FIREFOX_DIR}/${OUT_NAME}"

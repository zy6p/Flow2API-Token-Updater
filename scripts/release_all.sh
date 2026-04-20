#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

require_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree must be clean before running release_all.sh" >&2
    exit 1
  fi
}

remote_repo_slug() {
  local remote_name="$1"
  local remote_url
  remote_url="$(git remote get-url "${remote_name}")"
  remote_url="${remote_url#git@github.com:}"
  remote_url="${remote_url#git@ssh.github.com:}"
  remote_url="${remote_url#https://github.com/}"
  remote_url="${remote_url%.git}"
  printf '%s' "${remote_url}"
}

VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
SELFHOST_VERSION="${FLOW2API_GECKO_SELFHOST_VERSION:-${VERSION}.2}"
SELFHOST_XPI="dist/firefox/flow2api_token_updater-selfhost-${SELFHOST_VERSION}.xpi"
TAG_NAME="${RELEASE_TAG:-${VERSION}}"
TARGET_BRANCH="${RELEASE_TARGET_BRANCH:-main}"
SOURCE_BRANCH="${RELEASE_SOURCE_BRANCH:-$(git branch --show-current)}"
ORIGIN_REMOTE="${RELEASE_ORIGIN_REMOTE:-origin}"
UPSTREAM_REMOTE="${RELEASE_UPSTREAM_REMOTE:-upstream}"
ORIGIN_REPO="${RELEASE_GH_REPO:-$(remote_repo_slug "${ORIGIN_REMOTE}")}"
UPSTREAM_REPO="${RELEASE_UPSTREAM_REPO:-$(remote_repo_slug "${UPSTREAM_REMOTE}" 2>/dev/null || true)}"
PAGES_PROJECT="${CF_PAGES_PROJECT:-banana-rematrixed-com}"
RELEASE_WITH_AMO_LISTED="${RELEASE_WITH_AMO_LISTED:-0}"
RELEASE_WITH_CWS="${RELEASE_WITH_CWS:-0}"
RELEASE_REQUIRE_SELFHOST="${RELEASE_REQUIRE_SELFHOST:-1}"
HEAD_SHA=""

if [[ -z "${ORIGIN_REPO}" ]]; then
  echo "Unable to determine GitHub repo slug for ${ORIGIN_REMOTE}" >&2
  exit 1
fi

require_clean_tree

git fetch "${ORIGIN_REMOTE}" --tags

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "${CURRENT_BRANCH}" != "${TARGET_BRANCH}" ]]; then
  git checkout "${TARGET_BRANCH}"
fi

if [[ "${SOURCE_BRANCH}" != "${TARGET_BRANCH}" ]]; then
  git merge --ff-only "${SOURCE_BRANCH}"
fi

node scripts/smoke_background.js

./scripts/sign_amo_unlisted.sh
if [[ "${RELEASE_WITH_AMO_LISTED}" == "1" ]]; then
  AMO_LISTED_ENABLED=1 ./scripts/sign_amo_listed.sh
else
  echo "Skipping AMO listed release; set RELEASE_WITH_AMO_LISTED=1 to enable it"
fi
if [[ "${RELEASE_WITH_CWS}" == "1" ]]; then
  ./scripts/sign_cws.sh
else
  echo "Skipping Chrome Web Store release; set RELEASE_WITH_CWS=1 to enable it"
fi
./scripts/build_cloudflare_pages.sh

if [[ "${RELEASE_REQUIRE_SELFHOST}" == "1" && ! -f "${SELFHOST_XPI}" ]]; then
  echo "Missing Firefox self-hosted XPI: ${SELFHOST_XPI}" >&2
  echo "Run scripts/sign_amo_unlisted.sh successfully first, or set RELEASE_REQUIRE_SELFHOST=0 to release without the auto-update Firefox bundle." >&2
  exit 1
fi

if [[ "${RELEASE_REQUIRE_SELFHOST}" == "1" ]]; then
  if ! node "${ROOT_DIR}/scripts/validate_gecko_signed_bundle.js" "${SELFHOST_XPI}" >/dev/null; then
    echo "Firefox self-hosted XPI is present but not actually signed: ${SELFHOST_XPI}" >&2
    echo "Release aborted so the download page cannot expose an unverified Firefox bundle." >&2
    exit 1
  fi
fi

HEAD_SHA="$(git rev-parse HEAD)"

if git rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
  EXISTING_TAG_SHA="$(git rev-list -n 1 "${TAG_NAME}")"
  if [[ "${EXISTING_TAG_SHA}" != "${HEAD_SHA}" ]]; then
    echo "Tag ${TAG_NAME} already exists locally at ${EXISTING_TAG_SHA}, not HEAD ${HEAD_SHA}" >&2
    exit 1
  fi
  echo "Reusing existing local tag ${TAG_NAME} at ${HEAD_SHA}"
else
  git tag -a "${TAG_NAME}" -m "release: ${TAG_NAME}"
fi

git push "${ORIGIN_REMOTE}" "${TARGET_BRANCH}"
if [[ "${SOURCE_BRANCH}" != "${TARGET_BRANCH}" ]]; then
  git push "${ORIGIN_REMOTE}" "${SOURCE_BRANCH}"
fi
git push "${ORIGIN_REMOTE}" "${TAG_NAME}"

PREV_TAG="$(git tag --sort=-version:refname | grep -v "^${TAG_NAME}$" | head -n 1 || true)"
RELEASE_NOTES_FILE="$(mktemp)"
trap 'rm -f "${RELEASE_NOTES_FILE}"' EXIT

{
  printf 'Release %s\n\n' "${TAG_NAME}"
  if [[ -n "${PREV_TAG}" ]]; then
    git log --pretty='- %s' "${PREV_TAG}..HEAD"
  else
    git log --pretty='- %s' HEAD
  fi
} > "${RELEASE_NOTES_FILE}"

RELEASE_ASSETS=(
  "dist/chromium/Flow2API-Token-Updater-chromium-${VERSION}.zip"
  "dist/firefox/flow2api_token_updater-gecko-temp-${VERSION}.zip"
  ".cloudflare-pages/downloads/latest.json"
  ".cloudflare-pages/downloads/SHA256SUMS"
)

if [[ -f "${SELFHOST_XPI}" ]]; then
  RELEASE_ASSETS+=("${SELFHOST_XPI}")
fi

if [[ -f ".cloudflare-pages/downloads/updates.json" ]]; then
  RELEASE_ASSETS+=(".cloudflare-pages/downloads/updates.json")
fi

if [[ "${RELEASE_WITH_AMO_LISTED}" == "1" ]]; then
  RELEASE_ASSETS+=(
    "web-ext-artifacts/flow2api-token-updater-amo-${VERSION}.zip"
    "web-ext-artifacts/flow2api-token-updater-source-${VERSION}.tar.gz"
  )
fi

if gh release view "${TAG_NAME}" --repo "${ORIGIN_REPO}" >/dev/null 2>&1; then
  gh release upload "${TAG_NAME}" "${RELEASE_ASSETS[@]}" --repo "${ORIGIN_REPO}" --clobber
  gh release edit "${TAG_NAME}" --repo "${ORIGIN_REPO}" --title "${TAG_NAME}" --notes-file "${RELEASE_NOTES_FILE}"
else
  gh release create "${TAG_NAME}" "${RELEASE_ASSETS[@]}" \
    --repo "${ORIGIN_REPO}" \
    --target "${TARGET_BRANCH}" \
    --title "${TAG_NAME}" \
    --notes-file "${RELEASE_NOTES_FILE}"
fi

npx --yes wrangler pages deploy .cloudflare-pages \
  --project-name "${PAGES_PROJECT}" \
  --branch "${TARGET_BRANCH}" \
  --commit-hash "${HEAD_SHA}" \
  --commit-message "release: ${TAG_NAME}" \
  --commit-dirty=true

if [[ -n "${UPSTREAM_REPO}" ]]; then
  gh pr create \
    --repo "${UPSTREAM_REPO}" \
    --base "${TARGET_BRANCH}" \
    --head "$(cut -d'/' -f1 <<< "${ORIGIN_REPO}"):${TARGET_BRANCH}" \
    --title "Release ${TAG_NAME}" \
    --body "Release ${TAG_NAME}" \
    || true
fi

printf 'Release %s finished.\n' "${TAG_NAME}"

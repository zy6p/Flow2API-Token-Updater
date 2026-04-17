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
TAG_NAME="${RELEASE_TAG:-${VERSION}}"
TARGET_BRANCH="${RELEASE_TARGET_BRANCH:-main}"
SOURCE_BRANCH="${RELEASE_SOURCE_BRANCH:-$(git branch --show-current)}"
ORIGIN_REMOTE="${RELEASE_ORIGIN_REMOTE:-origin}"
UPSTREAM_REMOTE="${RELEASE_UPSTREAM_REMOTE:-upstream}"
ORIGIN_REPO="${RELEASE_GH_REPO:-$(remote_repo_slug "${ORIGIN_REMOTE}")}"
UPSTREAM_REPO="${RELEASE_UPSTREAM_REPO:-$(remote_repo_slug "${UPSTREAM_REMOTE}" 2>/dev/null || true)}"
PAGES_PROJECT="${CF_PAGES_PROJECT:-banana-rematrixed-com}"
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
./scripts/sign_amo_listed.sh
./scripts/build_cloudflare_pages.sh

HEAD_SHA="$(git rev-parse HEAD)"

if git rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
  echo "Tag ${TAG_NAME} already exists locally" >&2
  exit 1
fi

git tag -a "${TAG_NAME}" -m "release: ${TAG_NAME}"

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
  "dist/firefox/flow2api_token_updater-${VERSION}.xpi"
  "dist/firefox/flow2api_token_updater-${VERSION}.zip"
  "dist/firefox/flow2api_token_updater-gecko-temp-${VERSION}.zip"
  "dist/firefox/flow2api_token_updater-selfhost-${VERSION}.2.xpi"
  "web-ext-artifacts/flow2api-token-updater-amo-${VERSION}.zip"
  "web-ext-artifacts/flow2api-token-updater-source-${VERSION}.tar.gz"
  ".cloudflare-pages/downloads/latest.json"
  ".cloudflare-pages/downloads/SHA256SUMS"
  ".cloudflare-pages/downloads/updates.json"
)

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

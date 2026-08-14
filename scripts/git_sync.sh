#!/usr/bin/env bash
# Force-sync working tree to origin — never merges, never prompts.
# Used by admin deploy, deploy_update.sh, and CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .git ]]; then
  echo "Not a git repository: ${ROOT}" >&2
  exit 2
fi

LOCK_FILE="${ROOT}/.git/deploy-sync.lock"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Git sync already in progress" >&2
  exit 3
fi

# Clear stuck git operations that block reset
git merge --abort 2>/dev/null || true
git rebase --abort 2>/dev/null || true
git cherry-pick --abort 2>/dev/null || true
rm -f .git/index.lock 2>/dev/null || true

echo "Fetching origin…"
git fetch --prune origin

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -z "${UPSTREAM}" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -n "${BRANCH}" && "${BRANCH}" != "HEAD" ]]; then
    UPSTREAM="origin/${BRANCH}"
  fi
fi
if [[ -z "${UPSTREAM}" ]] || ! git rev-parse --verify "${UPSTREAM}^{commit}" >/dev/null 2>&1; then
  for candidate in origin/master origin/main; do
    if git rev-parse --verify "${candidate}^{commit}" >/dev/null 2>&1; then
      UPSTREAM="${candidate}"
      break
    fi
  done
fi

if [[ -z "${UPSTREAM}" ]] || ! git rev-parse --verify "${UPSTREAM}^{commit}" >/dev/null 2>&1; then
  echo "Cannot resolve upstream branch (set tracking: git branch -u origin/main)" >&2
  exit 1
fi

LOCAL_BRANCH="${UPSTREAM#origin/}"
CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"

if [[ "${CURRENT}" == "HEAD" ]] || [[ "${CURRENT}" != "${LOCAL_BRANCH}" ]]; then
  if git show-ref --verify --quiet "refs/heads/${LOCAL_BRANCH}"; then
    git checkout -f "${LOCAL_BRANCH}"
  else
    git checkout -B "${LOCAL_BRANCH}" "${UPSTREAM}"
  fi
fi

git reset --hard "${UPSTREAM}"

SHA="$(git rev-parse --short HEAD)"
echo "Synced to ${UPSTREAM} (${SHA})"

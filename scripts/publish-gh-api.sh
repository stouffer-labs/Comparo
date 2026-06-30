#!/usr/bin/env bash
set -euo pipefail

# Publish Comparo's allowlisted files to GitHub via the Contents API (no git push).
# Code Defender blocks `git push` to external repos; the REST API bypasses it.

usage() {
  cat <<'EOF'
Sync allowlisted files to GitHub via Contents API.

Usage:
  scripts/publish-gh-api.sh [--owner O] [--repo R] [--branch B] [--create-repo] [--dry-run] [--no-skip-ci]
EOF
}

OWNER="${GITHUB_OWNER:-stouffer-labs}"
REPO="Comparo"
BRANCH="main"
DRY_RUN=0
CREATE_REPO=0
VISIBILITY="public"
SKIP_CI=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --create-repo) CREATE_REPO=1; shift ;;
    --public) VISIBILITY="public"; shift ;;
    --private) VISIBILITY="private"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-ci) SKIP_CI=1; shift ;;
    --no-skip-ci) SKIP_CI=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated; run: gh auth login" >&2; exit 1; }

# Each file is a separate commit, so publishing 60+ files fires 60+ rapid writes
# that routinely trip GitHub's secondary rate limit / transient 5xx (403/429/5xx).
# Without retries these surface as random per-file `failed=N` (a different file each
# run) — which previously forced manual re-runs. Retry transient HTTP codes with
# exponential backoff so a single invocation completes cleanly. (Ported from the
# Retrivio publish script, which never showed these failures because it retried.)
MAX_RETRIES="${PUBLISH_GH_API_MAX_RETRIES:-5}"
RETRY_BASE_DELAY_SEC="${PUBLISH_GH_API_RETRY_DELAY_SEC:-2}"

is_retryable_http_code() {
  case "$1" in
    403|408|409|425|429|500|502|503|504) return 0 ;;
    *) return 1 ;;
  esac
}

extract_http_code() {
  local text="${1:-}"
  if [[ "$text" =~ HTTP[[:space:]]+([0-9]{3}) ]]; then printf '%s' "${BASH_REMATCH[1]}"; return 0; fi
  if [[ "$text" =~ status[[:space:]]code:[[:space:]]*([0-9]{3}) ]]; then printf '%s' "${BASH_REMATCH[1]}"; return 0; fi
  return 1
}

# PUT a file's content with retry+backoff on transient errors. Returns 0 on
# success, 1 on a non-retryable error or after exhausting retries.
gh_put_with_retry() {
  local endpoint="$1" payload="$2" file="$3"
  local attempt=1 delay="$RETRY_BASE_DELAY_SEC" err_file err_text code
  while true; do
    err_file="$(mktemp -t comparo-put-err.XXXXXX)"
    if gh api --method PUT "$endpoint" --input "$payload" >/dev/null 2>"$err_file"; then
      rm -f "$err_file"; return 0
    fi
    err_text="$(cat "$err_file" 2>/dev/null || true)"; rm -f "$err_file"
    code="$(extract_http_code "$err_text" || true)"
    # Non-retryable error → give up immediately.
    if [[ -n "$code" ]] && ! is_retryable_http_code "$code"; then
      [[ -n "$err_text" ]] && echo "  $file: $err_text" >&2
      return 1
    fi
    if (( attempt >= MAX_RETRIES )); then
      [[ -n "$err_text" ]] && echo "  $file: $err_text" >&2
      return 1
    fi
    echo "warn: PUT ${file} failed${code:+ (HTTP ${code})}; retry ${attempt}/${MAX_RETRIES} in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1)); delay=$((delay * 2))
  done
}

# Strict allowlist. Anything not listed here is NEVER published.
ALLOWLIST=(
  "README.md"
  "LICENSE"
  ".gitignore"
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "vitest.config.ts"
  "COMPARO_PROMPT.md"
  "bin"
  "src"
  "tests"
  "docs"
  "scripts/install.sh"
  "scripts/publish-gh-api.sh"
  "scripts/new-release.sh"
  ".github/workflows"
  "Formula"
)

collect_files() {
  local path
  for path in "${ALLOWLIST[@]}"; do
    if [[ -f "$path" ]]; then
      printf '%s\n' "$path"
    elif [[ -d "$path" ]]; then
      # Exclude internal planning artifacts (specs/plans) from publication.
      find "$path" -type f ! -name '.DS_Store' ! -name '._*' ! -path '*/superpowers/*' -print
    fi
  done | sed 's#^\./##' | sort -u
}

mapfile -t FILES < <(collect_files)
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "nothing to sync"; exit 0
fi

# Repo existence / creation
if ! gh api "repos/${OWNER}/${REPO}" >/dev/null 2>&1; then
  if [[ "$CREATE_REPO" -eq 1 ]]; then
    [[ "$DRY_RUN" -eq 1 ]] && echo "dry-run: would create ${OWNER}/${REPO} (${VISIBILITY})" \
      || { echo "creating ${OWNER}/${REPO}..."; gh repo create "${OWNER}/${REPO}" "--${VISIBILITY}" >/dev/null; }
  else
    echo "error: repo ${OWNER}/${REPO} not found; rerun with --create-repo" >&2; exit 1
  fi
fi

echo "sync target: ${OWNER}/${REPO} (branch=${BRANCH}); files: ${#FILES[@]}"
[[ "$DRY_RUN" -eq 1 ]] && echo "mode: dry-run"

# Probe the remote blob SHA for a file. Echoes the 40-hex sha only on a real
# hit; echoes nothing if the repo/file does not exist. NOTE: on a 404, `gh api`
# prints the error JSON body to STDOUT (only "gh: Not Found" goes to stderr) and
# exits non-zero, so we cannot trust a non-empty capture — we must validate that
# the result actually looks like a blob sha. Anything else (error JSON, empty,
# "null") is treated as "file absent" → Add.
remote_sha() {
  local file="$1" out
  out="$(gh api "repos/${OWNER}/${REPO}/contents/${file}" --jq '.sha' 2>/dev/null || true)"
  # Use if/fi (not `&&`) so the function always returns 0 — "no sha" is a normal
  # result (file absent), and a non-zero return here would trip `set -e` at the
  # `sha="$(remote_sha ...)"` call site and abort the whole publish.
  if [[ "$out" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$out"; fi
  return 0
}

added=0; updated=0; failed=0
work_dir="$(mktemp -d -t comparo-publish.XXXXXX)"
trap 'rm -rf -- "${work_dir}"' EXIT
for file in "${FILES[@]}"; do
  [[ -f "$file" ]] || continue
  sha="$(remote_sha "$file")"
  msg="Add ${file}"; [[ -n "$sha" ]] && msg="Update ${file}"
  [[ "$SKIP_CI" -eq 1 ]] && msg="${msg} [skip ci]"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "dry-run: ${msg}"; continue
  fi
  content_file="${work_dir}/content"
  # `base64 < file` (not `-i`, which is macOS-only) for Linux portability.
  base64 < "$file" | tr -d '\n' >"$content_file"
  payload="${work_dir}/payload"
  if [[ -n "$sha" ]]; then
    jq -n --arg m "$msg" --rawfile c "$content_file" --arg s "$sha" --arg b "$BRANCH" \
      '{message:$m, content:$c, sha:$s, branch:$b}' >"$payload"
  else
    jq -n --arg m "$msg" --rawfile c "$content_file" --arg b "$BRANCH" \
      '{message:$m, content:$c, branch:$b}' >"$payload"
  fi
  if gh_put_with_retry "repos/${OWNER}/${REPO}/contents/${file}" "$payload" "$file"; then
    [[ -n "$sha" ]] && { echo "updated: $file"; updated=$((updated+1)); } \
      || { echo "added: $file"; added=$((added+1)); }
  else
    echo "failed: $file" >&2; failed=$((failed+1))
  fi
done

echo
echo "summary: added=${added} updated=${updated} failed=${failed}"
[[ "$failed" -gt 0 ]] && exit 1 || exit 0

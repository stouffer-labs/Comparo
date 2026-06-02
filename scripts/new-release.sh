#!/usr/bin/env bash
set -euo pipefail

# Create a release tag on GitHub via the API (no git push).
# Usage: scripts/new-release.sh v0.1.1

OWNER="${GITHUB_OWNER:-stouffer-labs}"
REPO="${GITHUB_REPO:-Comparo}"

TAG="${1:-}"
[[ -n "$TAG" ]] || { echo "usage: scripts/new-release.sh vX.Y.Z" >&2; exit 2; }
[[ "$TAG" == v* ]] || { echo "error: tag must start with 'v' (got '$TAG')" >&2; exit 2; }

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated" >&2; exit 1; }

SHA="$(gh api "repos/${OWNER}/${REPO}/git/ref/heads/main" --jq '.object.sha')"
[[ -n "$SHA" ]] || { echo "error: could not resolve main SHA" >&2; exit 1; }

gh api "repos/${OWNER}/${REPO}/git/refs" --method POST \
  -f ref="refs/tags/${TAG}" -f sha="$SHA" --jq '.ref'
echo "created tag ${TAG} at ${SHA}"

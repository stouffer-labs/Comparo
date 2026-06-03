#!/usr/bin/env bash
set -euo pipefail

# Install Comparo from source into a local, NAS-independent runtime.
#
# Usage:
#   scripts/install.sh                 # install from GitHub (main)
#   scripts/install.sh --from-source <path>   # install from a local checkout (dev)
#
# Environment variables:
#   COMPARO_GITHUB_OWNER   GitHub owner (default: stouffer-labs)
#   COMPARO_GITHUB_REPO    Repo name (default: Comparo)
#   COMPARO_INSTALL_DIR    Runtime dir (default: ~/.local/share/comparo)
#   COMPARO_BIN_DIR        Launcher dir (default: ~/.local/bin)

usage() {
  cat <<'EOF'
Install Comparo from source.

Usage:
  scripts/install.sh                      # install latest from GitHub main
  scripts/install.sh --from-source PATH   # install from a local checkout

Environment:
  COMPARO_GITHUB_OWNER  (default: stouffer-labs)
  COMPARO_GITHUB_REPO   (default: Comparo)
  COMPARO_INSTALL_DIR   (default: ~/.local/share/comparo)
  COMPARO_BIN_DIR       (default: ~/.local/bin)
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: required command not found: $1" >&2; exit 1; }
}

FROM_SOURCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-source)
      [[ -n "${2:-}" ]] || { echo "error: --from-source requires a path argument" >&2; exit 2; }
      FROM_SOURCE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

need_cmd node
need_cmd npm

OWNER="${COMPARO_GITHUB_OWNER:-stouffer-labs}"
REPO="${COMPARO_GITHUB_REPO:-Comparo}"
INSTALL_DIR="${COMPARO_INSTALL_DIR:-$HOME/.local/share/comparo}"
BIN_DIR="${COMPARO_BIN_DIR:-$HOME/.local/bin}"

# Guard: INSTALL_DIR must be an absolute path (also rejects empty/whitespace).
# This protects the `rm -rf "${INSTALL_DIR}"` below from a misconfigured value.
case "$INSTALL_DIR" in
  /*) : ;;
  *) echo "error: COMPARO_INSTALL_DIR must be an absolute path: '${INSTALL_DIR}'" >&2; exit 1 ;;
esac

tmp_dir="$(mktemp -d -t comparo-install.XXXXXX)"
trap "rm -rf -- '${tmp_dir}'" EXIT

if [[ -n "$FROM_SOURCE" ]]; then
  echo "comparo installer: source = local path ${FROM_SOURCE}"
  src_root="${FROM_SOURCE%/}"
else
  need_cmd curl
  need_cmd tar
  echo "comparo installer: source = github.com/${OWNER}/${REPO} (main)"
  curl -fsSL "https://github.com/${OWNER}/${REPO}/archive/refs/heads/main.tar.gz" -o "${tmp_dir}/src.tar.gz"
  tar -xzf "${tmp_dir}/src.tar.gz" -C "${tmp_dir}"
  src_root="$(find "${tmp_dir}" -maxdepth 1 -type d -name "${REPO}-*" | head -n1)"
  [[ -n "$src_root" ]] || { echo "error: extracted source dir not found" >&2; exit 1; }
fi

[[ -f "${src_root}/package.json" ]] || { echo "error: no package.json in ${src_root}" >&2; exit 1; }

echo "installing runtime to ${INSTALL_DIR}"
rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
# Copy source (excluding heavy/never-needed dirs); build happens in INSTALL_DIR.
tar -C "${src_root}" --exclude='./node_modules' --exclude='./.git' --exclude='./.comparo' \
    --exclude='./tmp' --exclude='./dist' -cf - . | tar -C "${INSTALL_DIR}" -xf -

# Build from source needs the dev toolchain (typescript + @types/node), so do a
# full `npm ci`, compile, then prune dev deps to leave a lean prod-only runtime.
( cd "${INSTALL_DIR}" && npm ci && npm run build && npm prune --omit=dev )

# Stable node symlink for the MCP registration. The MCP host spawns the server
# directly (no shell), inheriting whatever PATH it was launched with — which on
# GUI/fresh-shell launches lacks ~/.local/bin AND the nvm node dir. So the
# registration (written by `comparo mcp setup`) points at THIS absolute symlink
# rather than a bare `comparo` or a `#!/usr/bin/env node` shebang. Repointing it
# here on every (re)install keeps the registration node-version-agnostic.
node_bin="$(command -v node)"
ln -sf "${node_bin}" "${INSTALL_DIR}/bin/node"
echo "stable node symlink: ${INSTALL_DIR}/bin/node -> ${node_bin}"

mkdir -p "${BIN_DIR}"
ln -sf "${INSTALL_DIR}/bin/comparo.js" "${BIN_DIR}/comparo"
chmod +x "${INSTALL_DIR}/bin/comparo.js"

echo "linked ${BIN_DIR}/comparo -> ${INSTALL_DIR}/bin/comparo.js"
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  echo "hint: add ${BIN_DIR} to PATH"
fi

echo "registering MCP server in detected CLIs..."
"${BIN_DIR}/comparo" mcp setup || echo "warn: 'comparo mcp setup' reported issues; run it manually"

echo "done. health check:"
"${BIN_DIR}/comparo" doctor || true

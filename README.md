# Comparo

> MCP server that orchestrates independent AI CLI reviewers for cross-validation.

[![CI](https://github.com/stouffer-labs/Comparo/actions/workflows/ci-typescript.yml/badge.svg)](https://github.com/stouffer-labs/Comparo/actions/workflows/ci-typescript.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Comparo runs an independent AI CLI reviewer as a background job to cross-validate code and
designs, then consolidates the findings. It exposes this as MCP tools so any MCP-capable CLI
can request a second opinion.

**Reviewer:** Codex CLI. Adapters for Claude Code and Gemini CLI ship in `src/providers/`
but are not enabled — the reviewer set is fixed by `ProviderNameSchema` in `src/schemas.ts`,
so widen that enum to turn them on.

## Install

### macOS / Linux (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/stouffer-labs/Comparo/main/scripts/install.sh | bash
```

Installs Comparo to `~/.local/share/comparo`, links `comparo` into `~/.local/bin`, and
registers the MCP server in any detected CLIs.

Environment overrides: `COMPARO_INSTALL_DIR`, `COMPARO_BIN_DIR`, `COMPARO_GITHUB_OWNER`,
`COMPARO_GITHUB_REPO`.

### Homebrew tap

```bash
brew tap --custom-remote stouffer-labs/comparo https://github.com/stouffer-labs/Comparo
brew install stouffer-labs/comparo/comparo
```

Builds from source (`main`). Requires a working Homebrew + Node environment.

### Windows

```bash
npm install -g comparo
comparo mcp setup
```

(Comparo's Codex adapter automatically uses stdin on Windows to avoid the `cmd.exe` shim's
command-length cap and metacharacter mangling.)

## Quick Start

```bash
# Register the MCP server in your CLIs (idempotent)
comparo mcp setup

# Check provider health
comparo doctor
```

Once registered, call the `comparo_deep_review` / `comparo_check` MCP tools from your CLI.

## How it works

- `src/providers/` — one adapter per CLI
- `src/engines/` — review orchestration (parallel reviews, race, consolidate)
- `src/mcp/` — MCP server + tool handlers
- Reviews are fire-and-forget background jobs; callers poll with `comparo_check`.
- Session artifacts are written to `<cwd>/.comparo/` of the project being reviewed.

## Development

Requires Node 20 (see `.nvmrc`).

```bash
npm ci
npm run build
npm test
npm run lint
```

## Documentation

Full documentation: [stouffer-labs.github.io](https://stouffer-labs.github.io).

## Contributing

See the org [Contributing Guide](https://github.com/stouffer-labs/.github/blob/main/CONTRIBUTING.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).

# Comparo Distribution

End-user install paths and the maintainer release flow.

## End-User Install

### 1. One-line installer (recommended, macOS/Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/stouffer-labs/Comparo/main/scripts/install.sh | bash
```

Installs to `~/.local/share/comparo`, links `~/.local/bin/comparo`, and runs `comparo mcp setup`.

Environment overrides: `COMPARO_INSTALL_DIR`, `COMPARO_BIN_DIR`, `COMPARO_GITHUB_OWNER`, `COMPARO_GITHUB_REPO`.

### 2. Homebrew tap

```bash
brew tap --custom-remote stouffer-labs/comparo https://github.com/stouffer-labs/Comparo
brew install stouffer-labs/comparo/comparo
```

Builds from source (`main`) using Node. Requires a working Homebrew + Node environment.

### 3. Windows

```bash
npm install -g comparo
comparo mcp setup
```

The Codex adapter automatically uses stdin on Windows to avoid the `cmd.exe` shim's
command-length cap and metacharacter mangling.

## Maintainer Release Flow

This project has no local `.git`. Source is published via the GitHub Contents API.

### 1. Build and test locally

```bash
npm ci && npm run lint && npm run build && npm test
```

### 2. Publish source to GitHub

```bash
scripts/publish-gh-api.sh
```

Syncs the allowlisted files to `stouffer-labs/Comparo`. Each file is a separate commit;
`[skip ci]` is appended by default. **Do not use `--no-skip-ci`** -- it triggers a CI run per file.

### 3. Tag a release

```bash
scripts/new-release.sh v0.1.1
```

Creates the tag on GitHub at the current `main` SHA.

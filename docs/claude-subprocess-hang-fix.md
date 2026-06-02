# Claude Code Subprocess Hang: Root Cause Analysis & Fix

## Problem

When Comparo spawned Claude Code as a reviewer subprocess via `claude -p`, even trivial prompts like "What is 2+2?" would hang indefinitely (60-360+ seconds until timeout). Meanwhile, Gemini CLI completed the same reviews in ~17 seconds.

This blocked all Claude-as-reviewer functionality in Comparo.

## Environment

- Claude Code v2.1.51 / v2.1.52 (native arm64 binary)
- macOS Darwin 25.2.0
- Node.js v20.19.5
- execa v9.6.0
- Comparo spawns Claude via `execa('claude', ['-p', ...])` in `src/utils/process.ts`

## Investigation Timeline

### Phase 1: Timeout Tuning (Dead End)

Initial assumption was that the timeout was too low for agentic Claude responses.

- Increased `computeReviewTimeout` base from 300s to 600s to 900s
- Increased cap from 900s to 1200s to 1800s
- **Result**: Claude still hung regardless of timeout values. Even "2+2=?" took >120s before timing out.
- **Conclusion**: Not a timeout issue — Claude wasn't responding at all.

### Phase 2: Subprocess Isolation Flags (Partial Progress)

Investigated whether Claude's startup was slow due to loading MCP servers, plugins, and other initialization.

#### `--strict-mcp-config` with inline JSON
```bash
claude -p "..." --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```
- **Result**: Claude Code v2.1.51 hangs at startup. Debug log stops at "No git remote URL found".
- **Root cause**: Known bug — inline JSON with `--strict-mcp-config` causes hang.

#### `--strict-mcp-config` with file path
```bash
claude -p "..." --strict-mcp-config --mcp-config /path/to/empty-mcp.json
```
- **Result**: Same hang. Debug log identical pattern.
- **Root cause**: `--strict-mcp-config` itself is broken in v2.1.51, regardless of inline vs file.

#### `--tools ""` (empty string)
```bash
claude -p "..." --tools ""
```
- **Result**: Gets past plugin loading but hangs after "Fetched 0 servers".
- **Root cause**: Empty string for `--tools` causes a hang in Claude Code.

#### Working isolation flags
```bash
claude -p "..." \
  --setting-sources "project,local" \
  --plugin-dir /path/to/empty-dir \
  --disable-slash-commands \
  --tools "Read,Glob,Grep,WebSearch,WebFetch"
```
- `--setting-sources "project,local"` excludes user-level `enabledPlugins` (reduced from 11 to 1 plugin)
- `--plugin-dir /empty` overrides with empty plugin directory
- `--disable-slash-commands` skips slash command initialization
- `--tools "..."` must be a non-empty comma-separated list

**Result**: Startup went from ~5s to ~500ms in debug logs, but Claude **still hung** after initialization completed.

### Phase 3: Environment Variable Research (Dead End)

Researched potential env var fixes:

- `CLAUDE_CODE_SIMPLE=1`: Researched as a way to strip all initialization. **Does not exist / has no effect.** The research agent hallucinated this env var.
- Non-git directory bug (GitHub #23601): Investigated whether Claude hangs when cwd is not a git repo. **Not the root cause** — Claude hangs even with a git repo cwd.
- No-TTY bug (GitHub #9026): Investigated whether lack of TTY causes hang. Tested with `script -q /dev/null` wrapper. **Not the root cause.**

### Phase 4: The Breakthrough

#### Discovery 1: Background processes work fine

Running Claude in the background via bash `&` with a completely clean environment worked perfectly:

```bash
env -i HOME="$HOME" PATH="$PATH" claude -p "hi" \
  --output-format json --max-turns 1 --no-session-persistence \
  >stdout.txt 2>stderr.txt &
```
**Result**: Completed in 2.2 seconds with correct output.

#### Discovery 2: The nested session error

With `stdin: 'ignore'` in execa (which prevents the stdin pipe hang), Claude's actual error was revealed:

```
Error: Claude Code cannot be launched inside another Claude Code session.
Nested sessions share runtime resources and will crash all active sessions.
To bypass this check, unset the CLAUDECODE environment variable.
```

We were already doing `delete env.CLAUDECODE` — so why was it still set?

#### Discovery 3: execa v9 `extendEnv` default

**The root cause.** execa v9 defaults to `extendEnv: true`. This means even though our `runCommand()` function carefully built a custom env object and deleted `CLAUDECODE`:

```typescript
const processEnv = { ...process.env, ...filteredEnv };
delete processEnv.CLAUDECODE; // This deletion gets undone!
```

...execa re-merged `process.env` (which contains `CLAUDECODE=1`) back into the child's environment, silently undoing our deletion.

Verified with `printenv` in child process:

| execa config | `CLAUDECODE` in child |
|---|---|
| `extendEnv: true` (default) | `"1"` (re-added from process.env!) |
| `extendEnv: false` | `""` (properly deleted) |

#### Discovery 4: stdin pipe hang

Even after fixing the env var issue, Claude still hung when execa's default `stdin: 'pipe'` was used. Claude Code's `-p` mode checks stdin state during initialization and blocks if there's an unresolved open pipe. The bash `&` test worked because backgrounding detaches stdin.

## Root Causes (Two Bugs Working Together)

### Bug 1: execa v9 `extendEnv: true` silently re-adds deleted env vars

**File**: `src/utils/process.ts`

Our `runCommand()` builds a complete env object by copying `process.env`, merging caller's env vars, and deleting keys set to `undefined`. But execa v9's default `extendEnv: true` re-merges `process.env` on top of our carefully constructed env, re-adding `CLAUDECODE=1`.

Claude Code detects `CLAUDECODE=1` and either:
- Refuses to start (if stdin is detached): "cannot be launched inside another session"
- Hangs indefinitely (if stdin is piped): waits for parent session coordination that never comes

### Bug 2: execa default `stdin: 'pipe'` creates an unresolved pipe

**File**: `src/utils/process.ts`

execa defaults to `stdin: 'pipe'`, creating a pipe for the child's stdin. If nothing writes to it and nothing closes it, the child process blocks on stdin detection during initialization. Claude Code's `-p` flag means "use this prompt" but the startup sequence still inspects stdin before processing the `-p` argument.

## The Fix

Two lines in `src/utils/process.ts`:

```typescript
const subprocess = execa(opts.command, opts.args, {
  env: processEnv,
  extendEnv: false,  // We build the full env ourselves; prevent re-merging process.env
  stdin: opts.input !== undefined ? undefined : 'ignore',  // Detach stdin unless providing input
  cwd: opts.cwd,
  timeout: opts.timeout,
  // ...
});
```

Additionally in `src/providers/claude.ts`, we unset both session detection env vars:

```typescript
const env = {
  ...this.getReviewerEnv(),
  CLAUDECODE: undefined,           // Unset to prevent nested session detection
  CLAUDE_CODE_ENTRYPOINT: undefined, // Unset to prevent nested CLI detection
};
```

## Phase 5: Tool Permission Errors on Long Prompts

After fixing the hang, short prompts ("2+2=?") worked in 5.7s. But longer review prompts with context files returned **tool permission errors** — Claude tried to use WebSearch/WebFetch but was denied.

### Root Cause

Claude Code has two separate tool-related flags:

| Flag | Purpose |
|------|---------|
| `--tools` | Restricts which tools are **available** to the model |
| `--allowedTools` | **Pre-approves** tools for use without interactive confirmation |

We were only using `--tools`, which makes tools available but still requires interactive permission confirmation. In non-interactive `-p` mode, there's no way to confirm, so tool calls fail with `permission_denials`.

### Fix

Add `--allowedTools` with the same tool list:

```typescript
// In src/providers/claude.ts
args.push('--tools', tools, '--allowedTools', tools);
```

This makes tools both available AND pre-approved for non-interactive use.

### Notes

- Read-only tools (Read, Glob, Grep) generally don't need `--allowedTools` but it doesn't hurt
- WebSearch and WebFetch require it in `-p` mode (documented limitation, GitHub issue #581)
- `--dangerously-skip-permissions` is an alternative but skips ALL permission checks — too broad

---

## Verification

After all fixes, Claude subprocess completes in ~7 seconds for simple prompts and ~120 seconds for complex reviews with context files:

```
Simple prompt (2+2):
Duration: 5700ms, Exit code: 0

Complex review with context file:
Duration: 120800ms, Exit code: 0, Full structured review returned
```

## Key Takeaways

1. **execa v9 changed `extendEnv` default to `true`**. If you build a custom env and pass it to execa, it gets merged with `process.env` unless you set `extendEnv: false`. This is especially dangerous when you need to DELETE env vars from the child process.

2. **`stdin: 'pipe'` can cause child processes to hang** if the child inspects stdin during startup. Use `stdin: 'ignore'` for non-interactive subprocesses.

3. **Claude Code's nested session detection** uses the `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` environment variables. Both must be unset for legitimate subprocess spawning.

4. **Debug methodology**: The breakthrough came from running Claude in background (`&`) with `env -i` (clean env) — isolating that the binary itself works, and the issue was in how we spawned it. Then systematic A/B testing of execa options (`extendEnv`, `stdin`) pinpointed the exact cause.

5. **`--strict-mcp-config` is broken in Claude Code v2.1.51-52** (both inline JSON and file path). Don't use it. Instead use `--setting-sources "project,local"` + `--plugin-dir /empty-dir` for isolation.

6. **`--tools` and `--allowedTools` are separate concerns**. `--tools` controls availability; `--allowedTools` controls pre-approval. In non-interactive `-p` mode, you need both — otherwise tools that require confirmation (WebSearch, WebFetch) will fail silently with permission denials.

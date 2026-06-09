# Codex Reviewer Failure Modes: Analysis & Fixes

This document records the failure modes observed when Comparo uses `codex exec` as a
reviewer, the root-cause analysis for each, and what was changed. It exists because
these failures were repeatedly **conflated** across debugging sessions — three distinct
problems that present as "comparo returned an empty/useless result."

**TL;DR — there are three independent things:**

1. **Incomplete-turn handling bug (Comparo-side, FIXED)** — codex finishes but emits no
   final synthesis; Comparo used to surface mid-stream narration (or raw JSON) as the
   "answer." Fixed in `src/providers/codex.ts`.
2. **Skill-name warnings (cosmetic, NOT fatal)** — a plugin's skill names exceed codex's
   64-char limit and spam `ERROR` lines at startup. Codex runs fine anyway.
3. **Bedrock streaming outage (upstream, NOT fixable locally)** — `stream disconnected
   before completion` / `Exceeded on-demand capacity` → `turn.failed`. Intermittent,
   provider-wide. The outage itself can't be fixed locally, but as of the latest change
   Comparo now **detects it and reports it distinctly** (`unavailable: true`, a "review
   SKIPPED — model backend unavailable" banner) so the caller/user knows it's an upstream
   outage, not a review failure or a comparo bug. Re-run when the backend recovers.

A fast triage to tell them apart is in [Distinguishing the failure modes](#distinguishing-the-failure-modes).

> **Note on the gpt-5.5/Bedrock instability (2026-06-09):** the failures are intermittent
> — the same `codex exec` invocation fails during bad windows and succeeds (6/6) during good
> ones. "Interactive codex works but comparo fails" was **timing**, not an exec-vs-interactive
> difference: both use the identical Bedrock backend (`bedrock-mantle.us-east-2`). A controlled
> A/B test **refuted** the theory that comparo's 4 loaded MCP servers caused it — input tokens
> (~29,908) and success rate were identical with MCP servers on vs off. The only durable
> local mitigation is the explicit unavailability reporting above (we deliberately do NOT
> fall back to a weaker model).

---

## How Comparo invokes codex

```
codex exec - --full-auto --json --output-last-message <tmpfile> --skip-git-repo-check
```

- prompt piped via stdin (`-`), avoiding ARG_MAX on large review packets
- `--json` → newline-delimited JSON (JSONL) event stream on stdout
- `--output-last-message <tmpfile>` → codex also writes its last message to a file
- `--ephemeral` is used by the adapter (no session rollout persisted to disk)

### The modern codex `--json` event stream (cli 0.136.0)

```
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"..."}}      // assistant prose
{"type":"item.completed","item":{"type":"command_execution", ...}}          // shell tool call
{"type":"item.completed","item":{"type":"mcp_tool_call","server","tool","status", ...}}
{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens"}}
```

**There is no `stop_reason`/`finish_reason` field anywhere** (verified by exhaustive key
union across real runs). Any completion judgement must be inferential.

---

## Failure mode 1 — Incomplete turn (Comparo-side bug, FIXED)

### Symptom

A review "succeeds" but the returned text is a short mid-stream narration (e.g. a
393-char "I'm going to verify via internal code search…") instead of the actual
synthesis — or, in the worst case, a wall of raw JSONL.

### Root cause

Codex sometimes **ends its turn after a batch of tool calls without emitting a final
`agent_message`**. It narrates, runs verification tools, then `turn.completed` arrives
with no closing synthesis. This is **not** a Comparo cut-off: in every observed run codex
exited `0`, `timedOut=false`, and emitted its own `turn.completed` (a killed process would
truncate mid-event). The final tool calls all reported `status=completed`.

**Why codex does this is evidenced, not proven.** Strong correlation with very large
input on high reasoning effort:

| Run    | input_tokens | output_tokens | agent_messages | ended with | result     |
|--------|-------------:|--------------:|---------------:|------------|------------|
| 044530 | 174,380      | 7,321         | 4              | agent_message | GOOD (5774-char synthesis) |
| 054444 | 666,408      | 2,259         | 3              | 8 tool calls  | INCOMPLETE (no synthesis)  |
| 053945 | 31,095       | 0             | 0              | nothing       | EMPTY turn                 |

(Model `openai.gpt-5.5`, `reasoning_effort=xhigh`.) The likely mechanism is
context/turn-budget exhaustion — codex spends the turn on tool-driven verification and
ends before writing the synthesis. The stream exposes no stop reason, so this is the
best-supported explanation, not a certainty.

### The actual bug was Comparo's *handling*

The old parser:

```js
// read --output-last-message file; if non-empty, return it as text
// else: text = parseNdjsonForText(stdout);  return { text: text || stdout, ... }
```

Two defects:

1. **`parseNdjsonForText` only matched the legacy shape** (`obj.type==='message'` /
   `obj.message`). The modern stream uses `item.completed` with `item.type==='agent_message'`
   and `item.text`, so the fallback extracted **nothing** from modern output.
2. **`text || stdout` returned raw JSONL as the answer** when the output file was empty.
   Raw JSONL is non-empty, and the engine's success test is "non-empty `text`" — so
   **raw stream output was surfaced as a successful review** (silent corruption, not a
   visible error).

There was also a *refuted* hypothesis worth recording: "the parser picks an early message
instead of the last `agent_message`; fix = pick the last." This is a **no-op** — in every
run the extracted text already equalled the last `agent_message` (or was empty when none
existed). The defect was never selection; it was that no final synthesis existed and
Comparo presented a non-answer as the answer.

### The fix (`src/providers/codex.ts`)

- Parse the full JSONL event stream; take the **last `agent_message`** as the
  authoritative synthesis (supports both modern `item.completed` and legacy shapes).
- **Detect an INCOMPLETE turn** when any of:
  - there is no `agent_message` at all, OR
  - a tool-call item appears **after** the last `agent_message` (narrated → ran tools →
    stopped), OR
  - `output_tokens === 0` (genuinely empty/transient turn).
  - Note: `output_tokens` alone is insufficient — run 054444 had 2,259 output tokens yet
    was incomplete. The discriminating signal is *"is the last meaningful item an
    `agent_message`?"*
- On INCOMPLETE, return `text: ''` + an `error` describing why + `incomplete: true`, and
  preserve the full event array in `rawJson` for recovery/debugging.
- **Never** return raw stdout as `text` again.
- Added a prompt directive instructing codex to end with a single final synthesis message
  after any tool use (reduces recurrence at the source).

No engine change was required: the engine already fails a response with empty `text` +
`error`, so incomplete turns now appear in the "Failed Reviewers" report with a clear
reason instead of masquerading as success.

### Validation

The fix was validated against the three real run artifacts above: 044530 → complete
(recovers the full 5,774-char synthesis); 053945 and 054444 → `incomplete=true`, empty
text, correct reason. Unit tests in `tests/unit/providers/codex.test.ts` encode all three
shapes plus the raw-JSONL regression guard.

### Self-heal: what does NOT work

Auto-recovery via `codex exec resume <thread_id>` is **impossible while `--ephemeral` is
used** — ephemeral runs persist no session rollout, so resume fails with
`no rollout found for thread id (code -32600)` (verified). Options if auto-retry is wanted
later: drop `--ephemeral` (persists a session file per review, enabling resume), a fresh
re-run (works with ephemeral; matches the existing in-adapter retry in `claude.ts`), or
`codex exec --output-schema <FILE>` to force a schema-conforming final answer (preventive).
The current behavior is deliberate **fail-loud**, not auto-retry.

---

## Failure mode 2 — Skill-name warnings (cosmetic, NOT fatal)

### Symptom

At codex startup, ~12 lines like:

```
ERROR codex_core::session::session: failed to load skill
  /Users/<user>/.codex/plugins/cache/aim/AmazonBuilderCoreAIAgents-pipeline-assistant/<ver>/skills/apollo-code-fix-proposal/SKILL.md:
  invalid name: exceeds maximum length of 64 characters
```

### Root cause

Codex namespaces a skill as `<plugin>:<skill>`. For the
`AmazonBuilderCoreAIAgents-pipeline-assistant` plugin, names such as
`AmazonBuilderCoreAIAgents-pipeline-assistant:apollo-code-fix-proposal` exceed codex's
64-character limit, so codex refuses to load those individual skills.

### This is NOT why reviews fail

**Proven by direct reproduction:** with all 12 warnings present, codex still launches,
runs, and emits `agent_message`s every time. There is no panic, no fatal error, no failed
launch. Claims that "Codex won't launch / crashes at startup because of the plugin" are
**false**. Removing or updating the plugin does **not** make a failing review succeed.

### Mitigation (and why it is not durable)

Setting `enabled = false` under `[plugins."AmazonBuilderCoreAIAgents-pipeline-assistant@aim"]`
in `~/.codex/config.toml` silences the warnings — **but the AIM marketplace re-sync
(`[marketplaces.aim]`, source `~/.aim/cc-plugins`) reverts it to `true` and bumps the
plugin version on its next update.** A hand-edit is therefore temporary. A durable fix must
come from the plugin owner (shorten the skill directory names to fit 64 chars) or an
AIM-level disable. Since the warnings are cosmetic, this is low priority.

---

## Failure mode 3 — Bedrock streaming outage (upstream, NOT fixable locally)

### Symptom

```
{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}
{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion:
   The server had an error while processing your request. Sorry about that!)"}
... (repeats to 5/5) ...
{"type":"turn.failed"}
```

The model often *does* generate output, but the streaming connection to Bedrock drops
before the turn finalizes; codex retries 5× then gives up with `turn.failed` and
`turn.completed` never arrives.

### Root cause

An **upstream Bedrock model-serving / streaming problem**, not anything in codex, Comparo,
config, or the plugin. Verified:

- **Provider-wide**: all models fail identically when it's occurring (`openai.gpt-5.5`,
  `gpt-5.1`, `gpt-5`, `gpt-4.1`).
- **Independent of** reasoning effort, the plugin (fails the same with skills disabled),
  and invocation flags.
- **Intermittent**: on 2026-06-08 it was broken at 13:28, working at 13:51, broken again
  at 14:24.

### What to do

Nothing locally — **wait for Bedrock to recover and retry.** It does recover. With
failure mode 1 fixed, such an outage now surfaces as a clean `incomplete` result
("empty/transient turn") rather than a fragment or fake success.

---

## Distinguishing the failure modes

Run the canonical invocation and inspect the stream:

```bash
printf 'Reply with exactly one word: PONG' \
  | codex exec - --json --skip-git-repo-check 2>/tmp/cdx-err.txt
```

| Observation | Diagnosis | Action |
|---|---|---|
| `turn.completed` present, got `PONG` | Codex healthy | Ignore the warnings; if a *review* still fails, it's failure mode 1 (large/hard prompt) — re-run or simplify |
| Repeated `stream disconnected` → `turn.failed`, no `turn.completed` | Failure mode 3 (Bedrock outage) | Wait, retry later |
| `turn.completed` but a Comparo *review* returned narration/JSON | Failure mode 1 on old code | Ensure the fixed runtime is installed; **restart the session** (MCP servers load once at session start) |

`grep -c 'exceeds maximum' /tmp/cdx-err.txt` counts the cosmetic warnings (failure mode 2)
separately — they are never the cause.

---

## Operational note: MCP servers load once per session

The Comparo MCP server is spawned by the host (Claude Code / codex) **once at session
start** and is never reloaded. After deploying a Comparo fix (e.g. reinstalling to
`~/.local/share/comparo`), already-running sessions continue to run the **old** code until
**restarted**. New sessions pick up the fix automatically. Several "still broken after the
fix" reports traced to stale, pre-fix server processes rather than a new defect.

---

## References

- `src/providers/codex.ts` — invocation, stream parsing, incomplete-turn detection
- `tests/unit/providers/codex.test.ts` — the three failure shapes + raw-JSONL guard
- `src/engines/review.ts` — how reviewer responses are classified success/failed
- `docs/claude-subprocess-hang-fix.md` — a separate codex/claude subprocess RCA (env/stdin)

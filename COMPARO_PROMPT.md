# Comparo: Multi-AI Cross-Validation Orchestrator

## Project Summary

We are designing and building **Comparo**, an open-source CLI tool that orchestrates multiple AI coding CLI tools (Claude Code, Gemini CLI, Codex CLI) to enable cross-validation, parallel prompt racing, and iterative prompt refinement — all while using the user's existing **subscription-based authentication** (not API keys).

This project was born from a real developer workflow that consistently produces better AI outputs but is tedious to do manually. We have completed extensive research and ideation across multiple AI sessions. This document consolidates all findings, constraints, ideas, and architecture decisions so you can pick up with full context.

---

## The Three Core Workflows to Automate

### Workflow 1: Mid-Project Adversarial Review ("Cross-Check")

**Current manual process (happens ~once per hour):**
1. Developer works with one AI CLI (e.g., Claude Code) on a project
2. At a key decision point, developer copies conversation context into another AI CLI (e.g., Gemini CLI)
3. Developer frames the request: "Another AI researched this and came to these conclusions. Independently research this and give your opinion."
4. The reviewing AI **does its own research** — reads docs, searches the web, looks things up — before responding
5. Developer pastes the review back to the original AI: "Another AI reviewed your analysis. Re-assess based on their feedback."
6. The original AI produces a measurably better final answer

**Key requirement:** The reviewing AI must receive the FULL context window and have time/ability to do its own research, not just react to a summary. This isn't a quick "thumbs up/down" — it's a genuine independent analysis.

### Workflow 2: Multi-AI Project Kickoff ("Race")

**Current manual process (start of major projects):**
1. Developer opens 3 terminal windows side-by-side with Claude Code, Gemini CLI, and Codex CLI
2. Gives the same initial prompt to all three
3. Reads through all three responses, noting which AI handled which aspect best
4. Reformulates the prompt incorporating the best insights from all three
5. May iterate 1-2 more rounds
6. Picks the AI that "gets it" best and enhances its understanding with the insights it missed from the other two
7. Continues the project in that winning session

### Workflow 3: Iterative Prompt Refinement ("Consolidate")

**Current manual process (after extended iteration with one AI):**
1. Developer iterates with one AI, going back and forth, learning and adding requirements they didn't initially think of
2. At a stopping point, developer asks the AI to consolidate the entire discussion — research, requirements discovered, markdown files created, decisions made — into a single comprehensive prompt
3. Developer starts a fresh session with a new AI using this generated prompt
4. The second session goes significantly smoother because the prompt captures everything learned in the first session, organized coherently

---

## Critical Design Constraint: Subscription-Based Authentication

**This is the #1 architectural constraint.** The tool MUST work with the users' existing CLI subscriptions, NOT API keys.

### Why This Matters
- AI companies are losing money on subscription plans — they offer tremendous value
- Developers paying $100-400/month across subscriptions (Claude Max $100-200/mo, ChatGPT Pro $200/mo, Google AI Pro) are the target audience
- The value proposition is "unlock more value from subscriptions you already pay for," NOT "pay for another AI service"
- This is the key viral distribution angle: developers already paying for these subscriptions are power users who will immediately understand the value

### Technical Reality

| CLI Tool | Command | Subscription | Non-interactive Mode | Stdin Piping | JSON Output |
|----------|---------|-------------|---------------------|-------------|-------------|
| Claude Code | `claude` | Max ($100-200/mo) via `claude login` | `claude -p "prompt"` | Full support | `--output-format json` |
| Gemini CLI | `gemini` | Free / AI Pro via Google OAuth | `gemini "prompt"` (positional arg) | Full support | `--output-format json` |
| Codex CLI | `codex` | ChatGPT Pro ($200/mo) via `codex login` | `codex exec "prompt"` | **BROKEN** (open GitHub issue #1123) | `--json` |

**All three tools cache credentials after initial interactive login.** Subsequent non-interactive subprocess calls automatically use cached subscription auth. This means a wrapper/orchestrator CAN spawn these as subprocesses and they'll use subscriptions without any API key configuration.

### Detailed CLI Capabilities

**Claude Code (`claude -p`):**
- Best automation support of the three
- `--output-format json` returns structured `{result, session_id, ...}`
- `--output-format stream-json` for real-time streaming
- `--input-format stream-json` accepts NDJSON conversation on stdin (for chaining)
- `--continue` / `--resume <session_id>` for multi-turn conversations
- `--system-prompt-file` and `--append-system-prompt-file` for context injection
- `--max-turns` to limit agentic loops
- `--allowedTools` to auto-approve specific tools
- `--json-schema` for structured output
- Stdin piping: `cat context.txt | claude -p "Review this"`

**Gemini CLI (`gemini "prompt"`):**
- `--prompt` / `-p` flag is deprecated; use positional argument
- `@` syntax for file references: `gemini "Review @./src/ and @./README.md"`
- `--output-format json` returns `{response, stats, error}`
- `--approval-mode yolo` for auto-approving tool use
- `--resume latest` for session continuity
- 1M token context window with Gemini 2.5/3 Pro
- Stdin piping: `cat context.txt | gemini "Analyze this"`

**Codex CLI (`codex exec`):**
- Progress streams to stderr, final message to stdout
- `--json` for NDJSON event output
- `-o ./output.txt` to write final message to file
- `--output-schema ./schema.json` for structured output
- `--full-auto` for unattended operation
- `codex exec resume --last "follow-up"` for session continuity
- **Stdin piping is broken** — workaround: write prompt to a file in the project directory, then reference it, or use `codex exec "$(cat short-prompt.txt)"` for short prompts

### Codex Stdin Workaround Strategy
Since Codex can't accept long prompts via stdin:
1. Write the context/prompt to a file in the project directory (e.g., `.comparo/review-request.md`)
2. Invoke: `codex exec "Read the file .comparo/review-request.md and follow the instructions inside it" --full-auto`
3. Codex's file reading tools will pick up the full context
4. Clean up the file after the response

---

## Research Findings

### Why This Works (Academic Validation)

The cross-validation workflow is validated by multiple research findings:

- **Together AI's Mixture-of-Agents (MoA)** — ICLR 2025 Spotlight paper. LLMs generate better responses when they see outputs from other models, even weaker ones. Open-source models achieved 65.1% on AlpacaEval 2.0 vs. GPT-4 Omni's 57.5%.
- **Adaptive Heterogeneous Multi-Agent Debate** — Heterogeneous (different model family) debates consistently outperform single-model methods across six benchmarks (GSM8K, MMLU, arithmetic QA).
- **Karpathy's LLM Council** (late 2025) — Dispatches queries to a panel of frontier models, peer review phase, chairman synthesis. Council often produces results stronger than any individual model.
- **Language Model Council** (NAACL 2025) — 20 LLMs participate in test formulation, response generation, and collective judging. More separable, robust, and less biased than individual judges.
- **Key finding from "Debate or Vote"**: Majority Voting alone accounts for most performance gains attributed to Multi-Agent Debate, suggesting independent attempts matter more than the synthesis step.
- **Why it works mechanically**: LLMs have correlated blind spots within a model family but uncorrelated errors across families. Cross-validation forces each model to confront its own confident-but-wrong assumptions.

### Existing Tools and Why They Don't Solve This

| Tool | What It Does | Why It's Not Enough |
|------|-------------|-------------------|
| **PAL MCP Server** | Cross-model review via MCP | Uses API keys, not subscriptions |
| **Claude Squad** | Manages multiple CLI sessions in tmux | No cross-pollination between sessions; TUI-only, not programmable |
| **Karpathy's LLM Council** | Dispatch → review → synthesize | API-based, not subscription-based; web app, not CLI |
| **Promptfoo** | Compare model outputs | Evaluation/testing focused, not conversational; API-based |
| **Warp** | Multi-agent terminal | Proprietary, Mac-only, specific terminal app |
| **PolyCouncil** | Multi-model deliberation | Local models only (LM Studio) |
| **OpenCode** | CLI with mid-session model switching | Single tool, not cross-CLI orchestration |

**The gap: Nobody has built a subscription-aware orchestrator that drives the actual CLI tools as subprocesses.**

---

## Consolidated Ideas (From Multiple AI Sessions)

### Architecture Concepts

**1. Ghost Writer / Terminal Wrapper**
- Users run `comparo wrap claude` instead of `claude` directly
- Wrapper records stdin/stdout to a local buffer, stripping ANSI codes
- Hotkey (e.g., Ctrl+B, s) triggers a "send context to another pane" action
- Physically types into the other CLI window
- Pro: Zero change to how users work. Con: Fragile terminal scraping.

**2. Consensus File Protocol / Shared Brain**
- A `.comparo/state.md` file in the project root serves as shared state
- `comparo push` — saves current plan/context from one CLI session
- `comparo review` — reads shared state and feeds it to another CLI
- LLMs are better at reviewing structured documents than messy chat logs
- Pro: Clean structured data exchange. Con: Requires manual commands.

**3. Arena / Tournament Launcher**
- `comparo race "Build a REST API for inventory management"`
- Splits terminal into 3 panes (tmux), launches all 3 CLIs
- Pre-fills each with the prompt
- `comparo merge` — scrapes responses from all panes, uses a fast model to summarize unique points, generates a "Super Prompt" combining the best ideas
- Pastes merged prompt back into the winner's terminal
- Pro: Full visual control. Con: Complex tmux orchestration.

**4. Pane Orchestrator (tmux/wezterm-first)**
- Users keep 2-3 real CLI sessions open
- App sends prompts to selected panes, captures outputs
- Builds a comparison brief
- Works with subscriptions because each response is generated inside the official CLI

**5. Checkpoint Sidecar (single-primary flow)**
- User works in one CLI as primary
- Hotkey at decision points: sidecar packages context and asks other CLIs for independent review
- Returns structured summary: agree/disagree/risks/missing-tests
- Plus paste-ready feedback for the primary model
- Closest to Workflow 1

**6. MCP Server Wrapper**
- Expose cross-check as MCP tools so any MCP-compatible assistant can invoke it
- `cross_validate(context, question)` and `multi_prompt(prompt, models[])`
- Portable across any tool supporting MCP (Claude Code, Gemini CLI both support MCP)
- Con: The orchestrating AI controls what context gets sent (bias risk)

**7. Hybrid Architecture (Recommended)**

| Layer | Purpose | Distribution |
|-------|---------|-------------|
| Core CLI engine | Orchestrates subprocesses, manages context, compares outputs | `npm install -g comparo` / `brew install comparo` |
| MCP Server | Exposes engine as tools to MCP-compatible agents | MCP server config file |
| Claude Code Skill | `/comparo review` and `/comparo race` from within Claude Code | Published skill |
| Gemini CLI Skill | Same commands from within Gemini CLI | Published skill |

---

## Key Architecture Decision: Who Orchestrates?

Research shows the **external orchestrator** approach (Option 7 above) produces less biased results than letting one AI orchestrate the others (MCP-only approach). When Claude decides what context Gemini sees, it introduces selection bias. An external tool treats all models as peers.

**Recommended: External orchestrator as the core, with MCP/skill integration as convenience layers on top.**

---

## Technical Architecture (Proposed)

### Core Flow for Workflow 1 (Cross-Check)

```
Developer in Claude Code hits decision point
           │
           ▼
    comparo review \
      --context <captured context> \
      --question "Is this DB schema right?" \
      --reviewers gemini,codex
           │
           ├── Write context + question to .comparo/review-request.md
           │
           ├── Spawn: gemini "Read and follow instructions in .comparo/review-request.md" \
           │          --output-format json --approval-mode yolo
           │
           ├── Spawn: codex exec "Read .comparo/review-request.md and follow instructions" \
           │          --full-auto --json
           │
           ├── Collect JSON responses from both
           │
           ├── Format comparison output (agreements, disagreements, unique insights)
           │
           └── Print to stdout (or pipe back to claude --continue)
```

### Core Flow for Workflow 2 (Race)

```
    comparo race \
      --prompt "Build inventory REST API" \
      --models claude,gemini,codex \
      --rounds 2
           │
           ├── Round 1: Send prompt to all 3 in parallel
           │   ├── claude -p "..." --output-format json
           │   ├── gemini "..." --output-format json
           │   └── codex exec "..." --json
           │
           ├── Display side-by-side comparison
           │
           ├── User picks winner(s) / provides feedback
           │
           ├── Round 2: Generate merged prompt with cross-pollinated insights
           │   └── Send enhanced prompt to all 3 (or selected subset)
           │
           └── Final output: recommended lead model + consolidated prompt
```

### Core Flow for Workflow 3 (Consolidate)

```
    comparo consolidate \
      --from claude \
      --session <session_id or "latest">
           │
           ├── Extract conversation from Claude session
           │   (claude -p "Consolidate this entire discussion into a
           │    comprehensive prompt..." --continue --output-format json)
           │
           ├── Save consolidated prompt to .comparo/consolidated-prompt.md
           │
           └── Ready to use:
               comparo race --prompt-file .comparo/consolidated-prompt.md
               # or manually paste into any AI
```

### Context Capture Strategies

The hardest part is getting context OUT of a running session. Options:

1. **`--continue` with extraction prompt**: Ask the AI to summarize its own session via `claude -p "Summarize our discussion..." --continue`
2. **Session file scraping**: Claude Code stores sessions in `~/.claude/sessions/`. These could be parsed directly.
3. **Wrapper approach**: If the user runs `comparo wrap claude`, we can capture the stream from the start.
4. **Manual context file**: User tells their AI "write a summary to .comparo/context.md" — the simplest and most reliable approach.
5. **Clipboard integration**: User copies relevant text, runs `comparo review --from-clipboard`

### Output Format

The comparison output should be structured and actionable:

```markdown
## Cross-Validation Report

### Prompt
"Is the proposed PostgreSQL schema correct for this use case?"

### Agreements (All models concur)
- PostgreSQL is appropriate for this workload
- The users table structure is sound
- REST over GraphQL for this API

### Disagreements
| Topic | Claude (Primary) | Gemini | Codex |
|-------|-----------------|--------|-------|
| Auth strategy | JWT tokens | Server sessions | OAuth2 + JWT hybrid |
| Orders table | JSON array for items | Junction table | Junction table |

### Unique Insights
- **Gemini** flagged: Missing index on orders.user_id will cause slow queries at scale
- **Codex** suggested: Add soft-delete pattern to users table for compliance

### Recommended Actions
1. Add junction table for order items (2/3 models agree)
2. Add index on orders.user_id (Gemini's performance concern is valid)
3. Investigate OAuth2 hybrid approach for auth (merits from all three)

### Raw Responses
<details><summary>Gemini Full Response</summary>
[full text]
</details>
<details><summary>Codex Full Response</summary>
[full text]
</details>
```

---

## Distribution Strategy

### Target Audience
Developers already paying for 2+ AI CLI subscriptions who want more value from them.

### Installation
```bash
npm install -g comparo
# or
brew install comparo
```

### First-Run Setup
```bash
comparo setup
# Detects which CLI tools are installed and authenticated
# Tests non-interactive mode for each
# Saves config to ~/.comparo/config.json
```

### Configuration
```json
{
  "models": {
    "claude": {
      "command": "claude",
      "flags": "-p --output-format json --max-turns 3",
      "installed": true,
      "authenticated": true
    },
    "gemini": {
      "command": "gemini",
      "flags": "--output-format json --approval-mode yolo",
      "installed": true,
      "authenticated": true
    },
    "codex": {
      "command": "codex",
      "subcommand": "exec",
      "flags": "--json --full-auto",
      "installed": true,
      "authenticated": true,
      "stdin_workaround": true
    }
  },
  "defaults": {
    "primary": "claude",
    "reviewers": ["gemini", "codex"],
    "timeout_seconds": 300,
    "max_context_lines": 500
  }
}
```

### Viral Growth Vectors
1. **npm/brew package** — developers find it naturally
2. **GitHub repo** — star-driven discovery, README with GIF demos
3. **MCP server** — listed in MCP directories, discoverable by Claude Code and Gemini CLI users
4. **Claude Code skill** — published to skills ecosystem
5. **Dev Twitter/Reddit** — "I saved $X by cross-validating AI outputs" angle
6. **Blog post** — "Why I run every major AI decision through 3 models" with before/after quality examples

---

## Open Questions to Resolve

1. **Technology choice**: Node.js (matches Claude Code/MCP ecosystem) vs. Python (broader reach, easier for some devs) vs. Go/Rust (single binary, fast, no runtime dependency)?

2. **Context capture**: Which strategy for getting context out of running sessions? The wrapper approach is most seamless but most complex. The manual "write to file" approach is simplest but requires user action.

3. **Timeout handling**: AI CLI tools can take 30 seconds to 5+ minutes depending on the task. How to handle timeouts gracefully? Show progress? Allow the user to extend?

4. **TUI vs. plain CLI**: Should `comparo race` launch a fancy terminal UI with live-updating panes, or should it be a simple CLI that prints results sequentially? TUI is cooler but harder to build and debug.

5. **How to handle the "reviewer needs to do its own research" requirement**: When cross-checking, the reviewing AI may need to read files, search the web, look up docs. This means we can't just use `claude -p` with `--max-turns 1` — we need to let the AI do multiple agentic turns. This increases response time but produces much better reviews.

6. **Extensibility**: Should users be able to add custom CLI tools (e.g., local Ollama, Aider, other agents) via config?

7. **Privacy/security**: Context may contain proprietary code. All processing should be local (no Comparo cloud service). But each AI's own cloud processing is expected and accepted by the user.

---

## What We Need From This Session

Please independently research the technical feasibility of this project, considering:

1. **Validate or challenge** the architecture above — are there better approaches we're missing?
2. **Prototype the core** — what's the minimum viable implementation that proves the concept works?
3. **Identify technical risks** — what's hardest about this? Where will we hit walls?
4. **Recommend the tech stack** — given the constraints (subscription CLI orchestration, cross-platform, developer audience)
5. **Consider the third workflow** (consolidate/prompt refinement) — this is undersupported in the current design
6. Do your own research on the current state of these CLI tools, MCP protocols, and multi-model orchestration landscape as of February 2026

Think deeply. Challenge assumptions. Bring your own perspective — don't just agree with what's written here.

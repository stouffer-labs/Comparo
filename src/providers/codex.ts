import { ProviderAdapter } from './interface.js';
import { runCommand } from '../utils/process.js';
import { logger } from '../utils/logger.js';
import { getTempFilePath, readTextFile, ensureDir, getComparoDir } from '../utils/file-ops.js';
import type { ProviderName, ProviderResponse, InvokeOptions, DiagnoseResult, ProviderConfig } from '../types.js';

// Prompts under this size go as a positional arg to `codex exec <prompt>`.
// Above this we pipe via stdin (`codex exec -`), avoiding ARG_MAX entirely.
const STDIN_THRESHOLD = 100_000;

// On Windows, `codex` resolves to the npm `codex.cmd` shim, so argv is routed
// through cmd.exe. cmd.exe caps the command line at ~8191 chars AND mangles
// shell metacharacters (common in markdown packets), which silently drops
// trailing flags like --skip-git-repo-check. The stdin path (`codex exec -`)
// bypasses cmd.exe argument parsing entirely, so we always prefer it there.
// Evaluated per call (not a module-level constant) so the platform can be
// mocked in tests; production behavior is identical since platform is constant
// for a process lifetime.
function alwaysUseStdin(): boolean {
  return process.platform === 'win32';
}

// Always-on directive: codex sometimes narrates, runs verification tools, then
// ends the turn WITHOUT writing a final answer (detected & failed downstream in
// parseResponse). Instructing it to finish with a single synthesis message after
// any tool use reduces that failure mode at the source.
const FINAL_SYNTHESIS_DIRECTIVE =
  'IMPORTANT: After any verification or tool use, end your turn with a single ' +
  'final message containing your complete answer/synthesis. Do not stop on a ' +
  'tool call or a narration line — your last message must be the full answer.';

function prependReviewerInstructions(prompt: string, isQuick: boolean): string {
  const preamble: string[] = [];
  if (isQuick) {
    preamble.push(
      'IMPORTANT: Quick mode — provide a focused assessment concisely.',
      'Prioritize the provided context and local file reads.',
      'Web searches are allowed for verification but keep them targeted (2-3 max).',
      'Do not modify any files.',
    );
  }
  preamble.push(FINAL_SYNTHESIS_DIRECTIVE);
  return [...preamble, '', prompt].join('\n');
}

export class CodexAdapter extends ProviderAdapter {
  readonly name: ProviderName = 'codex';
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;

  constructor(config: ProviderConfig) {
    super(config);
  }

  async invoke(opts: InvokeOptions): Promise<ProviderResponse> {
    const outputFile = getTempFilePath('codex-output', '.txt', opts.workingDirectory);
    await ensureDir(getComparoDir(opts.workingDirectory));

    // Codex supports `-` as the prompt arg to read from stdin,
    // which avoids ARG_MAX limits for large review packets. On Windows we
    // always use stdin to avoid the cmd.exe shim's length cap and metacharacter
    // mangling (see alwaysUseStdin above).
    const useStdin = alwaysUseStdin() || opts.prompt.length > STDIN_THRESHOLD;

    const args = [
      'exec',
      ...(useStdin ? ['-'] : [opts.prompt]),
      '--full-auto',
      '--json',
      '--output-last-message', outputFile,
      '--ephemeral',
      '--skip-git-repo-check',
    ];

    if (opts.safeMode) {
      args.push('-s', 'read-only');
    }

    const env = this.getReviewerEnv();

    const result = await runCommand({
      command: this.config.command,
      args,
      env,
      cwd: opts.workingDirectory,
      timeout: undefined,
      heartbeatIntervalMs: CodexAdapter.HEARTBEAT_INTERVAL_MS,
      onActivity: opts.onActivity,
      ...(useStdin ? { input: opts.prompt } : {}),
    });

    if (result.timedOut) {
      return this.makeTimedOutResponse(result.durationMs);
    }

    if (result.exitCode !== 0) {
      return this.makeErrorResponse(
        `Codex exited with code ${result.exitCode}: ${result.stderr}`,
        result.durationMs,
      );
    }

    return this.parseResponse(result.stdout, outputFile, result.durationMs, result.exitCode);
  }

  async invokeViaFile(
    filePath: string,
    opts: Omit<InvokeOptions, 'prompt'> & { contextFileCount?: number; depth?: string },
  ): Promise<ProviderResponse> {
    // Read the packet ourselves and pass content directly as the prompt.
    // This saves Codex from wasting an entire agentic turn just to read the file.
    const isQuick = opts.depth !== 'thorough';
    const content = await readTextFile(filePath);
    const prompt = prependReviewerInstructions(content, isQuick);

    logger.info(
      `Codex invokeViaFile: ${(content.length / 1000).toFixed(1)}k chars, ` +
      `mode=${isQuick ? 'quick' : 'thorough'}, ` +
      `delivery=${alwaysUseStdin() || prompt.length > STDIN_THRESHOLD ? 'stdin' : 'argv'}`,
    );

    return this.invoke({
      ...opts,
      prompt,
      // Quick reviews are read-only — no file modifications needed
      safeMode: isQuick || !!opts.safeMode,
    });
  }

  async diagnose(): Promise<DiagnoseResult> {
    try {
      const result = await runCommand({
        command: this.config.command,
        args: ['--version'],
        timeout: 10_000,
      });

      if (result.exitCode !== 0) {
        return { installed: false, error: result.stderr };
      }

      return {
        installed: true,
        version: result.stdout.trim(),
        authenticated: true,
        supportsJson: true,
      };
    } catch {
      return { installed: false, error: 'codex command not found' };
    }
  }

  private async parseResponse(
    stdout: string,
    outputFile: string,
    durationMs: number,
    exitCode: number,
  ): Promise<ProviderResponse> {
    const events = this.parseEvents(stdout);

    // FIRST: detect UPSTREAM UNAVAILABILITY (the model backend, e.g. Amazon
    // Bedrock, couldn't be reached). codex retries the stream internally up to 5
    // times; when those are exhausted the turn ends in `turn.failed` and/or the
    // stream emits repeated `error` events like "stream disconnected before
    // completion", "Exceeded on-demand capacity", or "The server had an error".
    // This is NOT a review failure or a comparo bug — it's an outage. Surface it
    // distinctly so the caller/user knows the review was SKIPPED due to backend
    // unavailability, rather than seeing a confusing empty/garbled result.
    const unavailability = this.detectUnavailability(events);
    if (unavailability) {
      logger.warn(`Codex backend UNAVAILABLE: ${unavailability}`);
      return {
        provider: this.name,
        text: '',
        rawJson: events.length > 0 ? events : null,
        durationMs,
        exitCode,
        error: `Codex review SKIPPED — model backend unavailable (upstream outage, not a review failure): ${unavailability}`,
        incomplete: true,
        unavailable: true,
      };
    }

    // The authoritative synthesis is the LAST agent_message in the stream.
    // (The --output-last-message file is only a convenience copy of it; we
    // derive from the stream so we can also reason about what came AFTER it.)
    const lastMessageIdx = this.lastAgentMessageIndex(events);
    const streamText = (lastMessageIdx >= 0 ? this.eventText(events[lastMessageIdx]) : '') ?? '';

    // Detect an INCOMPLETE turn: codex exited 0 but produced no usable final
    // answer. Three observed shapes (all from real runs):
    //   1. zero agent_message items, 0 output tokens  -> genuinely empty turn
    //   2. agent_message(s) but the turn ended with tool calls AFTER the last
    //      one -> codex narrated, ran verification tools, then stopped without
    //      writing a closing synthesis (the narration is NOT the answer)
    //   3. no agent_message at all (only tool calls) -> never answered
    // Note: output_tokens alone is insufficient (case 2 had 2259 tokens); the
    // discriminating signal is "is the last meaningful item an agent_message?".
    const outputTokens = this.outputTokens(events);
    const toolAfterLastMessage = this.hasToolCallAfter(events, lastMessageIdx);
    const incomplete =
      lastMessageIdx < 0 || toolAfterLastMessage || outputTokens === 0;

    if (incomplete) {
      const reason =
        lastMessageIdx < 0
          ? outputTokens === 0
            ? 'Codex ended the turn with no output (empty/transient turn)'
            : 'Codex produced no final message (only tool calls)'
          : 'Codex ended the turn after tool calls without a final synthesis message';
      logger.warn(`Codex turn INCOMPLETE: ${reason} (events=${events.length}, outputTokens=${outputTokens})`);
      return {
        provider: this.name,
        text: '',
        rawJson: events.length > 0 ? events : null,
        durationMs,
        exitCode,
        error: reason,
        incomplete: true,
      };
    }

    // Complete turn. Prefer the --output-last-message file when it matches the
    // final stream message (it preserves exact formatting); else use the stream.
    let text = streamText;
    try {
      const fileText = (await readTextFile(outputFile)).trim();
      if (fileText) {
        text = fileText;
      }
    } catch {
      logger.debug('Could not read codex output file; using stream-derived final message');
    }

    return {
      provider: this.name,
      text,
      rawJson: events.length > 0 ? events : null,
      durationMs,
      exitCode,
    };
  }

  /**
   * Detect that the model backend was unreachable. Returns a short human reason
   * string if the turn failed due to an upstream outage, else null.
   *
   * Signals (only treated as an outage when the turn did NOT complete, so a lone
   * transient reconnect that recovers is NOT flagged):
   *  - an explicit `turn.failed` event, OR
   *  - `error` events whose message matches a known upstream-outage signature:
   *    stream disconnected / exceeded on-demand capacity / server had an error /
   *    reconnecting / throttl / 429 / 5xx (transient), OR
   *    404 "Engine not found" / model-not-served (the configured model slug isn't
   *    available at the endpoint — actionable: wrong/retired model, not just an outage).
   */
  private detectUnavailability(events: Array<Record<string, unknown>>): string | null {
    const turnCompleted = events.some((e) => e.type === 'turn.completed');
    const turnFailed = events.some((e) => e.type === 'turn.failed');

    const OUTAGE = /stream disconnected|exceeded on-demand capacity|the server had an error|reconnecting\b|throttl|throughput|service unavailable|engine not found|\bnot found\b|\b404\b|\b429\b|\b50[0234]\b/i;

    // Scan both standalone `error` events and the nested `error.message` on a
    // `turn.failed` event (the 404 "Engine not found" lives in the latter).
    let lastOutageMsg: string | null = null;
    const consider = (msg: unknown) => {
      if (typeof msg === 'string' && OUTAGE.test(msg)) lastOutageMsg = msg;
    };
    for (const e of events) {
      if (e.type === 'error') consider(e.message);
      if (e.type === 'turn.failed') {
        const err = e.error as Record<string, unknown> | undefined;
        consider(err?.message);
      }
    }

    // Explicit failure: always an outage (codex gave up after its own retries).
    if (turnFailed) {
      return lastOutageMsg ?? 'codex reported turn.failed (no successful response from the model backend)';
    }
    // Outage-signature errors AND the turn never completed → unreachable.
    if (lastOutageMsg && !turnCompleted) {
      return lastOutageMsg;
    }
    return null;
  }

  /** Parse the codex `--json` JSONL stream into an array of event objects. */
  private parseEvents(stdout: string): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const line of stdout.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // Skip non-JSON lines (e.g. stray log output)
      }
    }
    return events;
  }

  /** Index of the last `item.completed` event whose item is an assistant message. */
  private lastAgentMessageIndex(events: Array<Record<string, unknown>>): number {
    for (let i = events.length - 1; i >= 0; i--) {
      if (this.eventText(events[i]) !== null) return i;
    }
    return -1;
  }

  /**
   * Extract assistant text from an event, supporting the modern shape
   * (`item.completed` with `item.type` agent_message/message and `item.text`/
   * `item.content`) and the legacy flat shape (`type: 'message'`). Returns the
   * text string, or null if the event is not an assistant message.
   */
  private eventText(event: Record<string, unknown> | undefined): string | null {
    if (!event) return null;
    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && (item.type === 'agent_message' || item.type === 'message')) {
        const t = item.text ?? item.content;
        if (typeof t === 'string' && t.trim()) return t.trim();
      }
      return null;
    }
    // Legacy flat shapes (older codex / other tools)
    if (event.type === 'message' && typeof event.content === 'string' && event.content.trim()) {
      return event.content.trim();
    }
    if (typeof event.message === 'string' && event.message.trim()) {
      return event.message.trim();
    }
    return null;
  }

  /** True if any tool-call item appears after index `afterIdx`. */
  private hasToolCallAfter(events: Array<Record<string, unknown>>, afterIdx: number): boolean {
    for (let i = afterIdx + 1; i < events.length; i++) {
      const event = events[i];
      if (event.type !== 'item.completed') continue;
      const item = event.item as Record<string, unknown> | undefined;
      if (item && (item.type === 'command_execution' || item.type === 'mcp_tool_call')) {
        return true;
      }
    }
    return false;
  }

  /** Output token count from the turn.completed usage, or 0 if absent. */
  private outputTokens(events: Array<Record<string, unknown>>): number {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn.completed') {
        const usage = events[i].usage as Record<string, unknown> | undefined;
        const out = usage?.output_tokens;
        return typeof out === 'number' ? out : 0;
      }
    }
    return 0;
  }
}

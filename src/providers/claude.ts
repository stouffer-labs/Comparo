import { basename, join } from 'node:path';
import { ProviderAdapter } from './interface.js';
import { runCommand } from '../utils/process.js';
import { readTextFile, getComparoDir, ensureDir, writeTextFile, getTempFilePath } from '../utils/file-ops.js';
import { logger } from '../utils/logger.js';
import type { ProviderName, ProviderResponse, InvokeOptions, DiagnoseResult, ProviderConfig } from '../types.js';

// Tools for reviews — file access + web verification
const REVIEW_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';
const QUICK_REVIEW_TOOLS = 'Read';
// Keep plenty of headroom under ARG_MAX so very large contexts don't fail with E2BIG.
const MAX_INLINE_PROMPT_CHARS = 200_000;
const QUICK_MAX_TURNS = 3;
const QUICK_MAX_TURNS_LARGE_PACKET = 5;
const BCC_FALLBACK_COMMAND = 'bcc';
const MIN_FALLBACK_TIMEOUT_MS = 5_000;
const AUTH_ERROR_PATTERNS = [
  /not logged in/i,
  /please run\s+\/login/i,
  /login required/i,
  /authentication required/i,
];

// Cache the isolation setup path
let isolationDir: string | null = null;

/**
 * Ensure isolation assets exist: an empty MCP config file plus an empty plugin dir.
 * Reviewer subprocesses use these to avoid loading user/project MCP servers and plugins.
 */
async function ensureIsolationAssets(): Promise<{ mcpConfigPath: string; pluginDir: string }> {
  if (!isolationDir) {
    isolationDir = join(getComparoDir(), 'claude-isolation');
  }
  const mcpConfigPath = join(isolationDir, 'empty-mcp.json');
  const pluginDir = join(isolationDir, 'empty-plugins');

  await ensureDir(pluginDir);
  await writeTextFile(mcpConfigPath, '{"mcpServers":{}}');

  return { mcpConfigPath, pluginDir };
}

export class ClaudeAdapter extends ProviderAdapter {
  readonly name: ProviderName = 'claude';

  constructor(config: ProviderConfig) {
    super(config);
  }

  async invoke(opts: InvokeOptions & { maxTurns?: number; tools?: string }): Promise<ProviderResponse> {
    if (opts.prompt.length > MAX_INLINE_PROMPT_CHARS) {
      const promptFile = getTempFilePath('claude-prompt', '.md', opts.workingDirectory);
      await writeTextFile(promptFile, opts.prompt);
      logger.info(`Claude prompt is ${(opts.prompt.length / 1000).toFixed(1)}k chars; using file handoff`);
      return this.invoke({
        ...opts,
        prompt: buildFileReadPrompt(promptFile, false),
      });
    }

    const maxTurns = opts.maxTurns;
    const tools = opts.tools ?? REVIEW_TOOLS;

    // Set up isolation assets for a strictly isolated reviewer subprocess.
    const { mcpConfigPath, pluginDir } = await ensureIsolationAssets();

    const args = [
      '-p', opts.prompt,
      '--output-format', 'json',
      '--no-session-persistence',
      // Strict reviewer isolation: empty MCP config, empty plugin dir, and
      // restricted setting sources to avoid loading user/project review extras.
      '--strict-mcp-config', mcpConfigPath,
      '--setting-sources', 'project,local',
      '--plugin-dir', pluginDir,
      '--disable-slash-commands',
    ];

    // Only cap turns when explicitly requested (e.g. simple single-turn prompts).
    // For reviews, let Claude use as many turns as it needs — the timeout is the real guard.
    if (maxTurns !== undefined) {
      args.push('--max-turns', String(maxTurns));
    }

    // Set available tools and pre-approve them for non-interactive -p mode.
    // --tools restricts which tools are available; --allowedTools auto-approves
    // them so Claude doesn't hang waiting for interactive permission confirmation.
    if (opts.excludeComparoMcp !== false) {
      args.push('--tools', tools, '--allowedTools', tools);
    }

    const env = {
      ...this.getReviewerEnv(),
      CLAUDECODE: undefined, // Unset to prevent nested session detection
      CLAUDE_CODE_ENTRYPOINT: undefined, // Unset to prevent nested CLI detection
    };

    logger.info(`Claude subprocess: max-turns=${maxTurns ?? 'unlimited'}, tools="${tools}", isolation=strict`);

    const timeout = opts.timeout ?? this.config.timeout;
    const primaryResult = await this.runClaudeCommand(this.config.command, args, env, opts.workingDirectory, timeout);

    if (this.shouldRetryWithBcc(primaryResult)) {
      logger.warn(`Claude reviewer auth failed (${this.getFailureDetail(primaryResult)}); retrying via bcc`);
      const remainingTimeout = timeout !== undefined
        ? Math.max(timeout - primaryResult.durationMs, 0)
        : undefined;

      if (remainingTimeout !== undefined && remainingTimeout < MIN_FALLBACK_TIMEOUT_MS) {
        logger.warn(`Skipping bcc retry because only ${remainingTimeout}ms remain`);
        return this.makeTimedOutResponse(primaryResult.durationMs);
      }

      const fallbackResult = await this.runClaudeCommand(
        BCC_FALLBACK_COMMAND,
        args,
        env,
        opts.workingDirectory,
        remainingTimeout,
      );
      const totalDuration = primaryResult.durationMs + fallbackResult.durationMs;

      if (fallbackResult.timedOut) {
        return this.makeTimedOutResponse(totalDuration);
      }

      if (fallbackResult.exitCode !== 0) {
        const primaryError = this.getFailureDetail(primaryResult);
        const fallbackError = this.getFailureDetail(fallbackResult);
        return this.makeErrorResponse(
          `Claude exited with code ${primaryResult.exitCode}: ${primaryError}\nFallback via bcc also failed: ${fallbackError}`,
          totalDuration,
        );
      }

      return this.parseResponse(fallbackResult.stdout, totalDuration, fallbackResult.exitCode);
    }

    if (primaryResult.timedOut) {
      return this.makeTimedOutResponse(primaryResult.durationMs);
    }

    if (primaryResult.exitCode !== 0) {
      return this.makeErrorResponse(
        `Claude exited with code ${primaryResult.exitCode}: ${this.getFailureDetail(primaryResult)}`,
        primaryResult.durationMs,
      );
    }

    return this.parseResponse(primaryResult.stdout, primaryResult.durationMs, primaryResult.exitCode);
  }

  async invokeViaFile(filePath: string, opts: Omit<InvokeOptions, 'prompt'> & { contextFileCount?: number; depth?: string }): Promise<ProviderResponse> {
    // Read the file ourselves and pass content directly as the prompt.
    // This avoids wasting an entire agentic turn just to call the Read tool.
    // For very large packets, use file handoff to avoid hitting argv size limits.
    const isQuick = opts.depth !== 'thorough';
    const content = await readTextFile(filePath);
    const isLargePacket = content.length > MAX_INLINE_PROMPT_CHARS;
    const prompt = isLargePacket
      ? buildFileReadPrompt(filePath, isQuick)
      : prependQuickModeInstructions(content, isQuick);

    if (isLargePacket) {
      logger.info(`Review packet is ${(content.length / 1000).toFixed(1)}k chars; using file handoff`);
    }

    return this.invoke({
      ...opts,
      prompt,
      // Quick mode is timeboxed and avoids web-search loops.
      // Thorough mode keeps full tooling and unlimited turns.
      maxTurns: isQuick ? (isLargePacket ? QUICK_MAX_TURNS_LARGE_PACKET : QUICK_MAX_TURNS) : undefined,
      tools: isQuick ? QUICK_REVIEW_TOOLS : REVIEW_TOOLS,
    });
  }

  async diagnose(): Promise<DiagnoseResult> {
    try {
      const result = await runCommand({
        command: this.config.command,
        args: this.wrapCommandArgs(this.config.command, ['--version']),
        timeout: 10_000,
      });

      if (result.exitCode !== 0) {
        return { installed: false, error: result.stderr };
      }

      return {
        installed: true,
        version: result.stdout.trim(),
        authenticated: true, // Claude uses subscription auth
        supportsJson: true,
      };
    } catch {
      return { installed: false, error: 'claude command not found' };
    }
  }

  private async runClaudeCommand(
    command: string,
    args: string[],
    env: Record<string, string | undefined>,
    cwd: string | undefined,
    timeout: number | undefined,
  ) {
    return runCommand({
      command,
      args: this.wrapCommandArgs(command, args),
      env,
      cwd,
      timeout,
    });
  }

  private parseResponse(stdout: string, durationMs: number, exitCode: number): ProviderResponse {
    try {
      const json = JSON.parse(stdout);
      const text = this.extractText(json);
      return {
        provider: this.name,
        text,
        rawJson: json,
        durationMs,
        exitCode,
      };
    } catch {
      logger.warn('Failed to parse Claude JSON output, using raw text');
      return {
        provider: this.name,
        text: stdout,
        rawJson: null,
        durationMs,
        exitCode,
        error: 'JSON parse failed, raw text returned',
      };
    }
  }

  private extractText(json: unknown): string {
    if (!json || typeof json !== 'object') return String(json);

    const obj = json as Record<string, unknown>;

    // Claude -p --output-format json structure: { result: { content: [{ text: "..." }] } }
    // Also handle: { result: "string" } or { content: [{ text: "..." }] }
    if (obj.result && typeof obj.result === 'object') {
      const result = obj.result as Record<string, unknown>;
      if (Array.isArray(result.content)) {
        const textBlocks = result.content
          .filter((block: unknown) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text')
          .map((block: unknown) => (block as Record<string, unknown>).text as string);
        if (textBlocks.length > 0) return textBlocks.join('\n');
      }
    }

    if (typeof obj.result === 'string') return obj.result;

    // Fallback: stringify
    return JSON.stringify(json, null, 2);
  }

  private shouldRetryWithBcc(result: { exitCode: number; stdout: string; stderr: string }): boolean {
    if (!this.isClaudeCommand(this.config.command)) return false;
    if (result.exitCode === 0) return false;
    const detail = this.getFailureDetail(result);
    return AUTH_ERROR_PATTERNS.some(pattern => pattern.test(detail));
  }

  private getFailureDetail(result: { stdout: string; stderr: string }): string {
    const structuredError = this.extractStructuredError(result.stdout);
    if (structuredError) return structuredError;

    const detail = result.stderr.trim() || result.stdout.trim();
    return detail || 'Unknown Claude subprocess failure';
  }

  private wrapCommandArgs(command: string, args: string[]): string[] {
    return this.isBccCommand(command) ? ['--', ...args] : args;
  }

  private extractStructuredError(stdout: string): string | null {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (parsed.is_error === true && typeof parsed.result === 'string' && parsed.result.trim()) {
        return parsed.result.trim();
      }
    } catch {
      // Ignore non-JSON stdout.
    }

    return null;
  }

  private isClaudeCommand(command: string): boolean {
    return basename(command) === 'claude';
  }

  private isBccCommand(command: string): boolean {
    return basename(command) === BCC_FALLBACK_COMMAND;
  }
}

function prependQuickModeInstructions(prompt: string, isQuick: boolean): string {
  if (!isQuick) return prompt;
  return [
    'Quick mode: return a best-effort answer within about 1-2 minutes.',
    'Do not use web search; focus on local context and files.',
    '',
    prompt,
  ].join('\n');
}

function buildFileReadPrompt(filePath: string, isQuick: boolean): string {
  const base = `Read the file at "${filePath}" and follow the instructions within it.`;
  return prependQuickModeInstructions(base, isQuick);
}

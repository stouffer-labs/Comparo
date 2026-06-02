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

function prependQuickModeInstructions(prompt: string, isQuick: boolean): string {
  if (!isQuick) return prompt;
  return [
    'IMPORTANT: Quick mode — provide a focused assessment concisely.',
    'Prioritize the provided context and local file reads.',
    'Web searches are allowed for verification but keep them targeted (2-3 max).',
    'Do not modify any files.',
    '',
    prompt,
  ].join('\n');
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
    const prompt = prependQuickModeInstructions(content, isQuick);

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
    // Try reading the output file first
    try {
      const outputText = await readTextFile(outputFile);
      if (outputText.trim()) {
        return {
          provider: this.name,
          text: outputText.trim(),
          rawJson: this.tryParseNdjson(stdout),
          durationMs,
          exitCode,
        };
      }
    } catch {
      logger.debug('Could not read codex output file, falling back to NDJSON parsing');
    }

    // Fallback: parse NDJSON stream from stdout
    const text = this.parseNdjsonForText(stdout);
    return {
      provider: this.name,
      text: text || stdout,
      rawJson: this.tryParseNdjson(stdout),
      durationMs,
      exitCode,
      error: text ? undefined : 'Parsed from raw output',
    };
  }

  private tryParseNdjson(stdout: string): unknown {
    const lines = stdout.trim().split('\n');
    const parsed: unknown[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Skip non-JSON lines
      }
    }
    return parsed.length > 0 ? parsed : null;
  }

  private parseNdjsonForText(stdout: string): string {
    const lines = stdout.trim().split('\n');
    const textParts: string[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        // Look for message content in NDJSON events
        if (obj.type === 'message' && typeof obj.content === 'string') {
          textParts.push(obj.content);
        } else if (obj.message && typeof obj.message === 'string') {
          textParts.push(obj.message);
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    return textParts.join('\n');
  }
}

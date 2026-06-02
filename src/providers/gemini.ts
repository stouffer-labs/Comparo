import { ProviderAdapter } from './interface.js';
import { runCommand } from '../utils/process.js';
import { logger } from '../utils/logger.js';
import type { ProviderName, ProviderResponse, InvokeOptions, DiagnoseResult, ProviderConfig } from '../types.js';

export class GeminiAdapter extends ProviderAdapter {
  readonly name: ProviderName = 'gemini';

  constructor(config: ProviderConfig) {
    super(config);
  }

  async invoke(opts: InvokeOptions): Promise<ProviderResponse> {
    const args = [
      '-p', opts.prompt,
      '--output-format', 'json',
      '--approval-mode', 'yolo',
    ];

    if (opts.safeMode) {
      args.push('--sandbox');
    }

    const env = this.getReviewerEnv();

    const result = await runCommand({
      command: this.config.command,
      args,
      env,
      cwd: opts.workingDirectory,
      timeout: opts.timeout ?? this.config.timeout,
    });

    if (result.timedOut) {
      return this.makeTimedOutResponse(result.durationMs);
    }

    if (result.exitCode !== 0) {
      return this.makeErrorResponse(
        `Gemini exited with code ${result.exitCode}: ${result.stderr}`,
        result.durationMs,
      );
    }

    return this.parseResponse(result.stdout, result.durationMs, result.exitCode);
  }

  async invokeViaFile(filePath: string, opts: Omit<InvokeOptions, 'prompt'>): Promise<ProviderResponse> {
    return this.invoke({
      ...opts,
      prompt: `Read the file ${filePath} and follow the instructions within it.`,
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
      return { installed: false, error: 'gemini command not found' };
    }
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
      logger.warn('Failed to parse Gemini JSON output, using raw text');
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

    // Gemini CLI JSON output: { response: "..." }
    if (typeof obj.response === 'string') return obj.response;

    // Fallback: stringify
    return JSON.stringify(json, null, 2);
  }
}

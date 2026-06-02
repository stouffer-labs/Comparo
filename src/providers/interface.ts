import type { ProviderName, ProviderResponse, InvokeOptions, DiagnoseResult, ProviderConfig } from '../types.js';

export abstract class ProviderAdapter {
  abstract readonly name: ProviderName;

  constructor(protected config: ProviderConfig) {}

  abstract invoke(opts: InvokeOptions): Promise<ProviderResponse>;
  abstract invokeViaFile(filePath: string, opts: Omit<InvokeOptions, 'prompt'> & Record<string, unknown>): Promise<ProviderResponse>;
  abstract diagnose(): Promise<DiagnoseResult>;

  protected getReviewerEnv(): Record<string, string | undefined> {
    return {
      COMPARO_IS_REVIEWER: '1',
    };
  }

  protected makeErrorResponse(error: string, durationMs: number): ProviderResponse {
    return {
      provider: this.name,
      text: '',
      rawJson: null,
      durationMs,
      exitCode: 1,
      error,
    };
  }

  protected makeTimedOutResponse(durationMs: number): ProviderResponse {
    return {
      provider: this.name,
      text: '',
      rawJson: null,
      durationMs,
      exitCode: 1,
      timedOut: true,
      error: `Timed out after ${durationMs}ms`,
    };
  }
}

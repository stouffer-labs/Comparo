export type ProviderName = 'claude' | 'gemini' | 'codex';

export interface ProviderResponse {
  provider: ProviderName;
  text: string;
  rawJson: unknown;
  durationMs: number;
  exitCode: number;
  error?: string;
  timedOut?: boolean;
  /**
   * True when the provider's process exited 0 but did not produce a usable final
   * synthesis (e.g. codex narrated, ran tools, then ended the turn with no closing
   * message; or an empty/zero-token turn). Such responses carry an empty `text`
   * plus an `error` describing why, so the engine fails them loudly instead of
   * surfacing mid-stream narration (or raw stream output) as if it were the answer.
   */
  incomplete?: boolean;
  /**
   * True when the provider could not reach its model backend (e.g. the codex
   * stream to Amazon Bedrock disconnected repeatedly / "Exceeded on-demand
   * capacity" / the turn ended in `turn.failed`). This is an UPSTREAM outage,
   * not a problem with the request or with comparo — surfaced distinctly so the
   * caller (and user) knows the review was skipped due to backend unavailability
   * rather than a real review failure. Implies `incomplete`.
   */
  unavailable?: boolean;
}

export type ProviderActivitySource = 'stdout' | 'stderr' | 'heartbeat';

export interface ProviderActivityEvent {
  source: ProviderActivitySource;
  timestamp: number;
}

export interface InvokeOptions {
  prompt: string;
  workingDirectory?: string;
  timeout?: number;
  excludeComparoMcp?: boolean;
  safeMode?: boolean;
  onActivity?: (event: ProviderActivityEvent) => void | Promise<void>;
}

export interface InvokeViaFileOptions extends Omit<InvokeOptions, 'prompt'> {
  filePath: string;
}

export interface DiagnoseResult {
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  supportsJson?: boolean;
  error?: string;
}

export interface ProviderConfig {
  command: string;
  maxTurns?: number;
  timeout?: number;
}

export interface ComparoConfig {
  providers: {
    claude: ProviderConfig;
    gemini: ProviderConfig;
    codex: ProviderConfig;
  };
  defaults: {
    timeout: number;
    maxTurns: number;
    maxRuns: number;
  };
  safeMode?: boolean;
}

export type ReviewDepth = 'quick' | 'thorough';

export interface ReviewRequest {
  context: string;
  question: string;
  reviewers: ProviderName[];
  contextFiles?: string[];
  depth: ReviewDepth;
}

export interface RaceRequest {
  prompt: string;
  models: ProviderName[];
}

export interface ConsolidateRequest {
  context: string;
  format: 'transfer_packet' | 'prompt';
}

export interface ComparisonSection {
  name: string;
  entries: Record<ProviderName, string>;
}

export interface ComparisonResult {
  question: string;
  responses: ProviderResponse[];
  failed: Array<{ provider: ProviderName; error: string }>;
  sections: ComparisonSection[];
}

export interface RunRecord {
  runId: string;
  type: 'review' | 'race' | 'consolidate';
  timestamp: string;
  request: ReviewRequest | RaceRequest | ConsolidateRequest;
  responses: ProviderResponse[];
  comparison?: ComparisonResult;
}

export interface ProviderExecutionObserver {
  onProviderStart?: (
    provider: ProviderName,
    details: { timeoutMs: number },
  ) => void | Promise<void>;
  onProviderActivity?: (
    provider: ProviderName,
    event: ProviderActivityEvent,
  ) => void | Promise<void>;
  onProviderComplete?: (
    provider: ProviderName,
    response: ProviderResponse,
  ) => void | Promise<void>;
  onProviderFail?: (
    provider: ProviderName,
    error: string,
  ) => void | Promise<void>;
}

export type ProviderName = 'claude' | 'gemini' | 'codex';

export interface ProviderResponse {
  provider: ProviderName;
  text: string;
  rawJson: unknown;
  durationMs: number;
  exitCode: number;
  error?: string;
  timedOut?: boolean;
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

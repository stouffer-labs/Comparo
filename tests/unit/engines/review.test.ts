import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeReview } from '../../../src/engines/review.js';
import type { ComparoConfig, ReviewRequest } from '../../../src/types.js';

// Mock all provider dependencies
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../../src/utils/file-ops.js', () => ({
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  getTempFilePath: vi.fn().mockReturnValue('/mock/.comparo/review-request.md'),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  getComparoDir: vi.fn().mockReturnValue('/mock/.comparo'),
  getRunsDir: vi.fn().mockReturnValue('/mock/.comparo/runs'),
  generateRunId: vi.fn().mockReturnValue('20250101-120000-abc12345'),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../src/providers/registry.js', () => ({
  getProviders: vi.fn(),
}));

import { getProviders } from '../../../src/providers/registry.js';

const mockGetProviders = vi.mocked(getProviders);

const mockConfig: ComparoConfig = {
  providers: {
    claude: { command: 'claude', maxTurns: 5, timeout: 30_000 },
    gemini: { command: 'gemini', timeout: 30_000 },
    codex: { command: 'codex', timeout: 30_000 },
  },
  defaults: { timeout: 30_000, maxTurns: 5, maxRuns: 50 },
};

describe('executeReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted comparison when reviewers succeed', async () => {
    const mockGeminiProvider = {
      name: 'gemini' as const,
      invokeViaFile: vi.fn().mockResolvedValue({
        provider: 'gemini',
        text: '### My Assessment\nLooks good.\n\n### Risks\nNone major.',
        rawJson: null,
        durationMs: 5000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockGeminiProvider] as never);

    const request: ReviewRequest = {
      context: 'We built a REST API',
      question: 'Is the error handling adequate?',
      reviewers: ['gemini'],
      depth: 'quick',
    };

    const result = await executeReview(request, mockConfig);

    expect(result).toContain('Cross-Validation Report');
    expect(result).toContain('Is the error handling adequate?');
    expect(result).toContain('gemini');
    expect(mockGeminiProvider.invokeViaFile).toHaveBeenCalledOnce();
  });

  it('handles all reviewers failing', async () => {
    const mockProvider = {
      name: 'codex' as const,
      invokeViaFile: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    mockGetProviders.mockReturnValue([mockProvider] as never);

    const request: ReviewRequest = {
      context: 'Some context',
      question: 'Question?',
      reviewers: ['codex'],
      depth: 'quick',
    };

    const result = await executeReview(request, mockConfig);
    expect(result).toContain('No successful responses');
  });

  it('treats fulfilled provider error responses as failures when no reviewer returns text', async () => {
    const mockProvider = {
      name: 'claude' as const,
      invokeViaFile: vi.fn().mockResolvedValue({
        provider: 'claude',
        text: '',
        rawJson: null,
        durationMs: 1000,
        exitCode: 1,
        error: 'Not logged in',
      }),
    };

    mockGetProviders.mockReturnValue([mockProvider] as never);

    const request: ReviewRequest = {
      context: 'Some context',
      question: 'Question?',
      reviewers: ['claude'],
      depth: 'quick',
    };

    const result = await executeReview(request, mockConfig);
    expect(result).toContain('No successful responses');
    expect(result).toContain('Not logged in');
  });

  it('treats empty fulfilled responses without an error as failures', async () => {
    const mockProvider = {
      name: 'claude' as const,
      invokeViaFile: vi.fn().mockResolvedValue({
        provider: 'claude',
        text: '',
        rawJson: null,
        durationMs: 1000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockProvider] as never);

    const request: ReviewRequest = {
      context: 'Some context',
      question: 'Question?',
      reviewers: ['claude'],
      depth: 'quick',
    };

    const result = await executeReview(request, mockConfig);
    expect(result).toContain('No successful responses');
    expect(result).toContain('Empty response with no error message');
  });

  it('handles partial failure (one succeeds, one fails)', async () => {
    const mockGemini = {
      name: 'gemini' as const,
      invokeViaFile: vi.fn().mockResolvedValue({
        provider: 'gemini',
        text: 'Gemini feedback',
        rawJson: null,
        durationMs: 5000,
        exitCode: 0,
      }),
    };
    const mockCodex = {
      name: 'codex' as const,
      invokeViaFile: vi.fn().mockRejectedValue(new Error('Timed out')),
    };

    mockGetProviders.mockReturnValue([mockGemini, mockCodex] as never);

    const request: ReviewRequest = {
      context: 'Context',
      question: 'Q?',
      reviewers: ['gemini', 'codex'],
      depth: 'quick',
    };

    const result = await executeReview(request, mockConfig);

    // Should still include gemini's response
    expect(result).toContain('gemini');
    expect(result).toContain('Gemini feedback');
  });

  it('scales quick review timeout up to the quick-mode cap', async () => {
    const mockClaudeProvider = {
      name: 'claude' as const,
      invokeViaFile: vi.fn().mockResolvedValue({
        provider: 'claude',
        text: '### My Assessment\nFast answer.',
        rawJson: null,
        durationMs: 1000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockClaudeProvider] as never);

    const request: ReviewRequest = {
      context: 'C'.repeat(250_000),
      question: 'Quick review please',
      reviewers: ['claude'],
      depth: 'quick',
    };

    await executeReview(request, mockConfig);

    const invokeArgs = mockClaudeProvider.invokeViaFile.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(invokeArgs.timeout).toBe(1_800_000);
  });

  it('gives codex a higher timeout floor for thorough reviews and forces read-only mode', async () => {
    const mockCodexProvider = {
      name: 'codex' as const,
      invokeViaFile: vi.fn().mockResolvedValue({
        provider: 'codex',
        text: '### My Assessment\nSlow but complete answer.',
        rawJson: null,
        durationMs: 1000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockCodexProvider] as never);

    const request: ReviewRequest = {
      context: 'D'.repeat(25_000),
      question: 'Research this thoroughly',
      reviewers: ['codex'],
      depth: 'thorough',
    };

    await executeReview(request, mockConfig);

    const invokeArgs = mockCodexProvider.invokeViaFile.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(invokeArgs.timeout).toBe(1_500_000);
    expect(invokeArgs.safeMode).toBe(true);
  });
});

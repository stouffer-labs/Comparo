import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeRace } from '../../../src/engines/race.js';
import type { ComparoConfig, RaceRequest } from '../../../src/types.js';

vi.mock('../../../src/utils/file-ops.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  getComparoDir: vi.fn().mockReturnValue('/mock/.comparo'),
  getRunsDir: vi.fn().mockReturnValue('/mock/.comparo/runs'),
  generateRunId: vi.fn().mockReturnValue('20250101-120000-abc12345'),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
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

describe('executeRace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rankings when models succeed', async () => {
    const mockGeminiProvider = {
      name: 'gemini' as const,
      invoke: vi.fn().mockResolvedValue({
        provider: 'gemini',
        text: 'Gemini answer',
        rawJson: null,
        durationMs: 2_000,
        exitCode: 0,
      }),
    };
    const mockCodexProvider = {
      name: 'codex' as const,
      invoke: vi.fn().mockResolvedValue({
        provider: 'codex',
        text: 'Codex answer',
        rawJson: null,
        durationMs: 5_000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockGeminiProvider, mockCodexProvider] as never);

    const request: RaceRequest = {
      prompt: 'Compare these implementations',
      models: ['gemini', 'codex'],
    };

    const result = await executeRace(request, mockConfig);

    expect(result).toContain('## Race Results');
    expect(result).toContain('1st. **gemini**');
    expect(result).toContain('2nd. **codex**');
  });

  it('gives codex a higher timeout floor during races', async () => {
    const mockCodexProvider = {
      name: 'codex' as const,
      invoke: vi.fn().mockResolvedValue({
        provider: 'codex',
        text: 'Codex answer',
        rawJson: null,
        durationMs: 1_000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockCodexProvider] as never);

    const request: RaceRequest = {
      prompt: 'Short prompt',
      models: ['codex'],
    };

    await executeRace(request, mockConfig);

    const invokeArgs = mockCodexProvider.invoke.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(invokeArgs.timeout).toBe(900_000);
  });

  it('still scales non-codex races by prompt size up to the race cap', async () => {
    const mockGeminiProvider = {
      name: 'gemini' as const,
      invoke: vi.fn().mockResolvedValue({
        provider: 'gemini',
        text: 'Gemini answer',
        rawJson: null,
        durationMs: 1_000,
        exitCode: 0,
      }),
    };

    mockGetProviders.mockReturnValue([mockGeminiProvider] as never);

    const request: RaceRequest = {
      prompt: 'A'.repeat(250_000),
      models: ['gemini'],
    };

    await executeRace(request, mockConfig);

    const invokeArgs = mockGeminiProvider.invoke.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(invokeArgs.timeout).toBe(1_200_000);
  });
});

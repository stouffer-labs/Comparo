import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    providers: {
      claude: { command: 'claude', timeout: 300_000 },
      gemini: { command: 'gemini', timeout: 300_000 },
      codex: { command: 'codex', timeout: 300_000 },
    },
    defaults: { timeout: 300_000, maxTurns: 5, maxRuns: 50 },
    safeMode: false,
  }),
}));

vi.mock('../../../src/engines/review.js', () => ({
  executeReview: vi.fn().mockResolvedValue('review-ok'),
  estimateReviewMaxRuntimeMs: vi.fn().mockReturnValue(120_000),
}));

vi.mock('../../../src/engines/race.js', () => ({
  executeRace: vi.fn().mockResolvedValue('race-ok'),
  estimateRaceMaxRuntimeMs: vi.fn().mockReturnValue(120_000),
}));

vi.mock('../../../src/persistence/job-tracker.js', () => ({
  createJobId: vi.fn().mockReturnValue('run-123'),
  startJob: vi.fn().mockResolvedValue(undefined),
  completeJob: vi.fn().mockResolvedValue(undefined),
  failJob: vi.fn().mockResolvedValue(undefined),
}));

import { handleReview } from '../../../src/mcp/tools/review.js';
import { handleRace } from '../../../src/mcp/tools/race.js';
import { loadConfig } from '../../../src/config/loader.js';
import { executeReview } from '../../../src/engines/review.js';
import { executeRace } from '../../../src/engines/race.js';
import { createJobId, startJob } from '../../../src/persistence/job-tracker.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockExecuteReview = vi.mocked(executeReview);
const mockExecuteRace = vi.mocked(executeRace);
const mockCreateJobId = vi.mocked(createJobId);
const mockStartJob = vi.mocked(startJob);

const originalSandbox = process.env.CODEX_SANDBOX;
const originalNetworkDisabled = process.env.CODEX_SANDBOX_NETWORK_DISABLED;

describe('MCP sandbox guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateJobId.mockReturnValue('run-123');
  });

  afterEach(() => {
    if (originalSandbox === undefined) {
      delete process.env.CODEX_SANDBOX;
    } else {
      process.env.CODEX_SANDBOX = originalSandbox;
    }

    if (originalNetworkDisabled === undefined) {
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    } else {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = originalNetworkDisabled;
    }
  });

  it('blocks comparo_review before job start for claude in codex sandbox', async () => {
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

    const result = await handleReview({
      context: 'ctx',
      question: 'q',
      reviewers: ['claude'],
    }, {} as never);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Sandbox Blocked');
    expect(text).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockCreateJobId).not.toHaveBeenCalled();
    expect(mockStartJob).not.toHaveBeenCalled();
    expect(mockExecuteReview).not.toHaveBeenCalled();
  });

  it('blocks comparo_race before job start for gemini in codex sandbox', async () => {
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

    const result = await handleRace({
      prompt: 'hello',
      models: ['gemini'],
    }, {} as never);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Sandbox Blocked');
    expect(text).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockCreateJobId).not.toHaveBeenCalled();
    expect(mockStartJob).not.toHaveBeenCalled();
    expect(mockExecuteRace).not.toHaveBeenCalled();
  });

  it('allows codex-only review while sandboxed', async () => {
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

    const result = await handleReview({
      context: 'ctx',
      question: 'q',
      reviewers: ['codex'],
    }, {} as never);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Review Started');
    expect(mockLoadConfig).toHaveBeenCalledOnce();
    expect(mockCreateJobId).toHaveBeenCalledOnce();
    expect(mockStartJob).toHaveBeenCalledOnce();
    expect(mockExecuteReview).toHaveBeenCalledOnce();
  });
});

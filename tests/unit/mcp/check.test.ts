import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/job-tracker.js', () => ({
  getLatestRunId: vi.fn(),
  getJobState: vi.fn(),
  failJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/utils/file-ops.js', () => ({
  getRunsDir: vi.fn().mockReturnValue('/mock/.comparo/runs'),
}));

import { handleCheck } from '../../../src/mcp/tools/check.js';
import { getLatestRunId, getJobState, failJob } from '../../../src/persistence/job-tracker.js';

const mockGetLatestRunId = vi.mocked(getLatestRunId);
const mockGetJobState = vi.mocked(getJobState);
const mockFailJob = vi.mocked(failJob);

describe('handleCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  it('returns no jobs message when no run exists', async () => {
    mockGetLatestRunId.mockReturnValue(null);

    const result = await handleCheck({});
    expect(result.content[0]?.text).toContain('No comparo jobs found');
  });

  it('returns still-running status with runtime guidance', async () => {
    mockGetLatestRunId.mockReturnValue('run-123');
    mockGetJobState.mockResolvedValue({
      runId: 'run-123',
      type: 'review',
      status: 'running',
      startedAt: 950_000,
      maxRuntimeMs: 120_000,
      providers: {
        gemini: { status: 'completed', elapsedMs: 20_000, lastActivityAt: 980_000 },
        codex: { status: 'running', startedAt: 950_000, lastActivityAt: 995_000, timeoutMs: 900_000 },
      },
    });

    const result = await handleCheck({});
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Still Running');
    expect(text).toContain('**Expected max runtime:** 120s');
    expect(text).toContain('codex: running, last activity 5s ago');
    expect(text).toContain('gemini: completed in 20s');
    expect(text).toContain('/mock/.comparo/runs/run-123/events.log');
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it('does not auto-fail jobs past expected runtime when a provider is still active', async () => {
    mockGetJobState.mockResolvedValue({
      runId: 'run-active',
      type: 'race',
      status: 'running',
      startedAt: 40_000,
      maxRuntimeMs: 120_000,
      providers: {
        codex: { status: 'running', startedAt: 40_000, lastActivityAt: 970_000, timeoutMs: 900_000 },
      },
    });

    const result = await handleCheck({ runId: 'run-active' });
    const text = result.content[0]?.text ?? '';

    expect(mockFailJob).not.toHaveBeenCalled();
    expect(text).toContain('past its expected runtime');
    expect(text).toContain('Auto-fail is deferred while providers keep reporting activity');
  });

  it('auto-fails stale running jobs', async () => {
    mockGetJobState.mockResolvedValue({
      runId: 'run-stale',
      type: 'review',
      status: 'running',
      startedAt: 800_000,
      maxRuntimeMs: 120_000,
    });

    const result = await handleCheck({ runId: 'run-stale' });
    const text = result.content[0]?.text ?? '';

    expect(mockFailJob).toHaveBeenCalledOnce();
    expect(mockFailJob.mock.calls[0]?.[0]).toBe('run-stale');
    expect(mockFailJob.mock.calls[0]?.[1]).toContain('runtime limit (120s, elapsed 200s)');
    expect(text).toContain('Job Failed');
    expect(text).toContain('/mock/.comparo/runs/run-stale/events.log');
  });

  it('includes log path for failed jobs', async () => {
    mockGetJobState.mockResolvedValue({
      runId: 'run-failed',
      type: 'race',
      status: 'failed',
      startedAt: 900_000,
      elapsedMs: 40_000,
      error: 'test failure',
    });

    const result = await handleCheck({ runId: 'run-failed' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Job Failed');
    expect(text).toContain('test failure');
    expect(text).toContain('/mock/.comparo/runs/run-failed/events.log');
  });
});

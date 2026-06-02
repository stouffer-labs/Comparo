import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

import { appendFile } from 'node:fs/promises';

import {
  createJobId,
  startJob,
  completeJob,
  failJob,
  getJobState,
  getLatestRunId,
  startProvider,
  recordProviderActivity,
  completeProvider,
} from '../../../src/persistence/job-tracker.js';

describe('JobTracker', () => {
  it('creates a job with running status', async () => {
    const runId = createJobId();
    const job = await startJob(runId, 'review');

    expect(job.runId).toBe(runId);
    expect(job.status).toBe('running');
    expect(job.type).toBe('review');
  });

  it('completes a job with result', async () => {
    const runId = createJobId();
    await startJob(runId, 'review');
    await completeJob(runId, '## Report\nLooks good.');

    const state = await getJobState(runId);
    expect(state?.status).toBe('completed');
    expect(state?.result).toBe('## Report\nLooks good.');
    expect(state?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('fails a job with error', async () => {
    const runId = createJobId();
    await startJob(runId, 'race');
    await failJob(runId, 'All providers timed out');

    const state = await getJobState(runId);
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('All providers timed out');
  });

  it('returns null for unknown job', async () => {
    const state = await getJobState('nonexistent-id');
    expect(state).toBeNull();
  });

  it('tracks latest run ID', async () => {
    const id1 = createJobId();
    await startJob(id1, 'review');

    // Small delay to ensure different startedAt
    await new Promise(r => setTimeout(r, 10));

    const id2 = createJobId();
    await startJob(id2, 'race');

    expect(getLatestRunId()).toBe(id2);
  });

  it('updates elapsed time for running jobs', async () => {
    const runId = createJobId();
    await startJob(runId, 'review');

    // Wait a bit
    await new Promise(r => setTimeout(r, 50));

    const state = await getJobState(runId);
    expect(state?.status).toBe('running');
    expect(state?.elapsedMs).toBeGreaterThan(0);
  });

  it('writes lifecycle events to events.log', async () => {
    const runId = createJobId();
    await startJob(runId, 'review', { maxRuntimeMs: 120_000 });
    await completeJob(runId, 'ok');

    const mockAppendFile = vi.mocked(appendFile);
    expect(mockAppendFile).toHaveBeenCalled();
    const loggedPaths = mockAppendFile.mock.calls.map(call => String(call[0]));
    expect(loggedPaths.some(path => path.endsWith('/events.log'))).toBe(true);
  });

  it('tracks provider lifecycle and activity inside a running job', async () => {
    const runId = createJobId();
    await startJob(runId, 'race', { providers: ['gemini', 'codex'] });
    await startProvider(runId, 'codex', { timeoutMs: 900_000 });
    await recordProviderActivity(runId, 'codex');
    await completeProvider(runId, 'codex');

    const state = await getJobState(runId);
    expect(state?.providers?.gemini?.status).toBe('pending');
    expect(state?.providers?.codex?.status).toBe('completed');
    expect(state?.providers?.codex?.timeoutMs).toBe(900_000);
    expect(state?.providers?.codex?.lastActivityAt).toBeGreaterThan(0);
  });
});

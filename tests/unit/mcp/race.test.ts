import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../src/engines/race.js', () => ({
  executeRace: vi.fn().mockResolvedValue('race-ok'),
  estimateRaceMaxRuntimeMs: vi.fn().mockReturnValue(930_000),
}));

vi.mock('../../../src/persistence/job-tracker.js', () => ({
  createJobId: vi.fn().mockReturnValue('run-123'),
  startJob: vi.fn().mockResolvedValue(undefined),
  completeJob: vi.fn().mockResolvedValue(undefined),
  failJob: vi.fn().mockResolvedValue(undefined),
}));

import { handleRace } from '../../../src/mcp/tools/race.js';
import { createJobId, startJob } from '../../../src/persistence/job-tracker.js';
import { executeRace, estimateRaceMaxRuntimeMs } from '../../../src/engines/race.js';

const mockCreateJobId = vi.mocked(createJobId);
const mockStartJob = vi.mocked(startJob);
const mockExecuteRace = vi.mocked(executeRace);
const mockEstimateRaceMaxRuntimeMs = vi.mocked(estimateRaceMaxRuntimeMs);

describe('handleRace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateJobId.mockReturnValue('run-123');
    mockEstimateRaceMaxRuntimeMs.mockReturnValue(930_000);
  });

  it('reports the computed max runtime instead of stale fixed text', async () => {
    const result = await handleRace({
      prompt: 'hello',
      models: ['codex'],
    }, {} as never);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Race Started');
    expect(text).toContain('**Expected max runtime:** up to 16 minutes');
    expect(text).toContain('Polling guidance');
    expect(mockStartJob).toHaveBeenCalledOnce();
    expect(mockExecuteRace).toHaveBeenCalledOnce();
  });
});

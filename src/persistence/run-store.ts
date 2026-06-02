import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { generateRunId, getRunsDir, ensureDir, writeJsonFile, writeTextFile } from '../utils/file-ops.js';
import { logger } from '../utils/logger.js';
import type { ProviderResponse, RunRecord, ComparisonResult, ReviewRequest, RaceRequest, ConsolidateRequest } from '../types.js';

export async function persistRun(opts: {
  type: RunRecord['type'];
  request: ReviewRequest | RaceRequest | ConsolidateRequest;
  responses: ProviderResponse[];
  comparisonMarkdown?: string;
  comparisonData?: ComparisonResult;
  workingDirectory?: string;
  maxRuns?: number;
}): Promise<string> {
  const runId = generateRunId();
  const runDir = join(getRunsDir(opts.workingDirectory), runId);

  try {
    await ensureDir(runDir);

    // Save request
    await writeJsonFile(join(runDir, 'request.json'), {
      type: opts.type,
      timestamp: new Date().toISOString(),
      request: opts.request,
    });

    // Save individual responses
    for (const response of opts.responses) {
      await writeJsonFile(
        join(runDir, `${response.provider}-response.json`),
        response,
      );
    }

    // Save comparison
    if (opts.comparisonMarkdown) {
      await writeTextFile(join(runDir, 'comparison.md'), opts.comparisonMarkdown);
    }
    if (opts.comparisonData) {
      await writeJsonFile(join(runDir, 'comparison.json'), opts.comparisonData);
    }

    logger.debug(`Run persisted to ${runDir}`);

    // Prune old runs
    if (opts.maxRuns && opts.maxRuns > 0) {
      await pruneRuns(getRunsDir(opts.workingDirectory), opts.maxRuns);
    }

    return runId;
  } catch (error) {
    logger.warn(`Failed to persist run: ${error}`);
    return runId;
  }
}

async function pruneRuns(runsDir: string, maxRuns: number): Promise<void> {
  try {
    const entries = await readdir(runsDir);
    // Run IDs are date-sorted by name (YYYYMMDD-HHMMSS-xxxx)
    const sorted = entries.sort();
    const toDelete = sorted.slice(0, Math.max(0, sorted.length - maxRuns));

    for (const entry of toDelete) {
      await rm(join(runsDir, entry), { recursive: true, force: true });
      logger.debug(`Pruned old run: ${entry}`);
    }
  } catch {
    // Non-critical — don't fail the save
  }
}

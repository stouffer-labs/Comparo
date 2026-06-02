import { z } from 'zod';
import { join } from 'node:path';
import { CheckInputSchema } from '../../schemas.js';
import { failJob, getJobState, getLatestRunId, type JobState } from '../../persistence/job-tracker.js';
import { getRunsDir } from '../../utils/file-ops.js';
import { logger } from '../../utils/logger.js';

const CHECK_GUIDANCE_SECONDS = 60;
const STALE_GRACE_MS = 15_000;
const ACTIVE_PROVIDER_GRACE_MS = 90_000;

export const checkToolDefinition = {
  name: 'comparo_check',
  description:
    'Check the status of a running comparo job and retrieve results when complete. If no run ID is provided, checks the most recent job. Returns the full report when complete, or status with elapsed time if still running.',
  inputSchema: CheckInputSchema,
};

export async function handleCheck(
  input: z.infer<typeof CheckInputSchema>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const runId = input.runId || getLatestRunId();

  if (!runId) {
    return {
      content: [{
        type: 'text' as const,
        text: 'No comparo jobs found. Start a review or race first.',
      }],
    };
  }

  const state = await getJobState(runId);

  if (!state) {
    return {
      content: [{
        type: 'text' as const,
        text: `Run \`${runId}\` not found. Check the run ID and try again.`,
      }],
    };
  }

  logger.debug(`comparo_check: ${runId} -> ${state.status}`);

  switch (state.status) {
    case 'running': {
      const elapsedMs = Date.now() - state.startedAt;
      const elapsed = Math.round(elapsedMs / 1000);
      const runtimeLimitMs = getRuntimeLimitMs(state);
      const runtimeLimitSec = Math.round(runtimeLimitMs / 1000);
      const logPath = join(getRunsDir(), runId, 'events.log');
      const recentProviderActivity = hasRecentProviderActivity(state, Date.now());
      const providerSummary = formatProviderSummary(state, Date.now());

      if (elapsedMs > runtimeLimitMs + STALE_GRACE_MS && !recentProviderActivity) {
        const staleError = [
          `Job exceeded its runtime limit (${runtimeLimitSec}s, elapsed ${elapsed}s).`,
          `This usually means the MCP process was interrupted before the background task could persist completion.`,
        ].join(' ');
        await failJob(runId, staleError);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `## Job Failed`,
              ``,
              `**Run ID:** \`${runId}\``,
              `**Type:** ${state.type}`,
              `**Elapsed:** ${elapsed}s`,
              `**Error:** ${staleError}`,
              `**Logs:** \`${logPath}\``,
              ``,
              `Try rerunning the ${state.type}. If this repeats, inspect the run log for the last lifecycle event.`,
            ].join('\n'),
          }],
        };
      }

      const remainingSec = Math.max(0, runtimeLimitSec - elapsed);
      return {
        content: [{
          type: 'text' as const,
          text: [
            `## Still Running`,
            ``,
            `**Run ID:** \`${runId}\``,
            `**Type:** ${state.type}`,
            `**Elapsed:** ${elapsed}s`,
            `**Expected max runtime:** ${runtimeLimitSec}s`,
            `**Logs:** \`${logPath}\``,
            ``,
            providerSummary,
            recentProviderActivity && elapsedMs > runtimeLimitMs
              ? `The ${state.type} is past its expected runtime, but at least one provider is still active.`
              : `The ${state.type} is still in progress. Check again in ${CHECK_GUIDANCE_SECONDS} seconds.`,
            recentProviderActivity
              ? `Auto-fail is deferred while providers keep reporting activity.`
              : `If it exceeds ${runtimeLimitSec}s total runtime, comparo_check will mark it failed automatically.`,
            recentProviderActivity
              ? `Most recent provider activity: ${formatRecentActivityAge(state, Date.now())}.`
              : `Estimated time remaining before auto-fail: ${remainingSec}s.`,
          ].join('\n'),
        }],
      };
    }

    case 'completed':
      return {
        content: [{
          type: 'text' as const,
          text: state.result ?? 'Completed but no result was captured.',
        }],
      };

    case 'failed':
      return {
        content: [{
          type: 'text' as const,
          text: [
            `## Job Failed`,
            ``,
            `**Run ID:** \`${runId}\``,
            `**Type:** ${state.type}`,
            `**Elapsed:** ${Math.round((state.elapsedMs ?? 0) / 1000)}s`,
            `**Error:** ${state.error}`,
            `**Logs:** \`${join(getRunsDir(), runId, 'events.log')}\``,
          ].join('\n'),
        }],
      };
  }
}

function hasRecentProviderActivity(state: JobState, now: number): boolean {
  return Object.values(state.providers ?? {}).some((providerState) =>
    providerState.status === 'running' &&
    typeof providerState.lastActivityAt === 'number' &&
    now - providerState.lastActivityAt <= ACTIVE_PROVIDER_GRACE_MS,
  );
}

function formatProviderSummary(state: JobState, now: number): string {
  const entries = Object.entries(state.providers ?? {});
  if (entries.length === 0) return '';

  const lines = ['**Providers:**'];
  for (const [provider, providerState] of entries) {
    switch (providerState.status) {
      case 'pending':
        lines.push(`- ${provider}: pending`);
        break;
      case 'running':
        lines.push(`- ${provider}: running, last activity ${formatAge(providerState.lastActivityAt, now)} ago`);
        break;
      case 'completed':
        lines.push(`- ${provider}: completed in ${Math.round((providerState.elapsedMs ?? 0) / 1000)}s`);
        break;
      case 'failed':
        lines.push(`- ${provider}: failed${providerState.error ? ` (${providerState.error})` : ''}`);
        break;
    }
  }
  lines.push('');
  return lines.join('\n');
}

function formatRecentActivityAge(state: JobState, now: number): string {
  const timestamps = Object.values(state.providers ?? {})
    .map((providerState) => providerState.lastActivityAt)
    .filter((value): value is number => typeof value === 'number');

  if (timestamps.length === 0) return 'unknown';
  return `${formatAge(Math.max(...timestamps), now)} ago`;
}

function formatAge(timestamp: number | undefined, now: number): string {
  if (typeof timestamp !== 'number') return 'unknown';
  return `${Math.max(0, Math.round((now - timestamp) / 1000))}s`;
}

function getRuntimeLimitMs(state: JobState): number {
  if (state.maxRuntimeMs && state.maxRuntimeMs > 0) {
    return state.maxRuntimeMs;
  }

  switch (state.type) {
    case 'review':
      return 20 * 60_000;
    case 'race':
      return 15 * 60_000;
    case 'consolidate':
      return 5 * 60_000;
  }
}

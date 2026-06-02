import { z } from 'zod';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { RaceInputSchema } from '../../schemas.js';
import { executeRace, estimateRaceMaxRuntimeMs } from '../../engines/race.js';
import { loadConfig } from '../../config/loader.js';
import {
  createJobId,
  startJob,
  completeJob,
  failJob,
  startProvider,
  recordProviderActivity,
  completeProvider,
  failProvider,
} from '../../persistence/job-tracker.js';
import { logger } from '../../utils/logger.js';
import type { RaceRequest } from '../../types.js';
import { getSandboxBlockForProviders } from '../../utils/sandbox-guard.js';

export const raceToolDefinition = {
  name: 'comparo_race',
  description:
    'Race multiple AI CLIs against each other with the same prompt. Runs in the background — returns a run ID immediately. Use comparo_check with the run ID to retrieve results.',
  inputSchema: RaceInputSchema,
};

export async function handleRace(
  input: z.infer<typeof RaceInputSchema>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const request: RaceRequest = {
    prompt: input.prompt,
    models: input.models,
  };

  const sandboxBlock = getSandboxBlockForProviders(request.models);
  if (sandboxBlock) {
    logger.warn(`Sandbox guard blocked race for providers: ${sandboxBlock.blockedProviders.join(', ')}`);
    return {
      content: [{
        type: 'text' as const,
        text: sandboxBlock.message,
      }],
    };
  }

  const config = await loadConfig();
  const runId = createJobId();
  const maxRuntimeMs = estimateRaceMaxRuntimeMs(request, config);
  await startJob(runId, 'race', { maxRuntimeMs, providers: request.models });

  // Fire and forget
  executeRace(request, config, {
    onProviderStart: (provider, details) => startProvider(runId, provider, { timeoutMs: details.timeoutMs }),
    onProviderActivity: (provider) => recordProviderActivity(runId, provider),
    onProviderComplete: (provider) => completeProvider(runId, provider),
    onProviderFail: (provider, error) => failProvider(runId, provider, error),
  })
    .then(async (result) => {
      await completeJob(runId, result);
    })
    .catch(async (err) => {
      await failJob(runId, String(err));
    });

  logger.info(`comparo_race started as background job ${runId}`);

  const modelList = request.models.join(', ');
  const expectedMaxRuntimeMin = Math.ceil(maxRuntimeMs / 60_000);
  return {
    content: [{
      type: 'text' as const,
      text: [
        `## Race Started`,
        ``,
        `**Run ID:** \`${runId}\``,
        `**Models:** ${modelList}`,
        ``,
        `The race is running in the background. Use \`comparo_check\` with run ID \`${runId}\` to retrieve results.`,
        ``,
        `**Expected max runtime:** up to ${expectedMaxRuntimeMin} minutes depending on prompt size and models.`,
        `**Polling guidance:** Wait at least 60 seconds before your first check.`,
      ].join('\n'),
    }],
  };
}

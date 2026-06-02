import { z } from 'zod';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ReviewInputSchema } from '../../schemas.js';
import { executeReview, estimateReviewMaxRuntimeMs } from '../../engines/review.js';
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
import type { ReviewRequest, ReviewDepth } from '../../types.js';
import { getSandboxBlockForProviders } from '../../utils/sandbox-guard.js';

export const reviewToolDefinition = {
  name: 'comparo_review',
  description:
    'Quick independent review from other AI CLIs. Reviewers analyze the provided context with minimal web searches (2-3 targeted lookups). Returns a run ID immediately — use comparo_check to retrieve results. Typically takes 1-2 minutes. For deep research with extensive web verification, use comparo_deep_review instead.',
  inputSchema: ReviewInputSchema,
};

export const deepReviewToolDefinition = {
  name: 'comparo_deep_review',
  description:
    'Deep independent review with thorough web research. Reviewers extensively verify claims against primary sources and official documentation. Returns a run ID immediately — use comparo_check to retrieve results. Typically takes 5-20 minutes depending on context size and reviewers. For quick reviews, use comparo_review instead.',
  inputSchema: ReviewInputSchema,
};

async function launchReview(
  input: z.infer<typeof ReviewInputSchema>,
  depth: ReviewDepth,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const request: ReviewRequest = {
    context: input.context,
    question: input.question,
    reviewers: input.reviewers,
    contextFiles: input.contextFiles,
    depth,
  };

  const sandboxBlock = getSandboxBlockForProviders(request.reviewers);
  if (sandboxBlock) {
    logger.warn(`Sandbox guard blocked review for providers: ${sandboxBlock.blockedProviders.join(', ')}`);
    return {
      content: [{
        type: 'text' as const,
        text: sandboxBlock.message,
      }],
    };
  }

  const config = await loadConfig();
  const runId = createJobId();
  const maxRuntimeMs = estimateReviewMaxRuntimeMs(request, config);
  await startJob(runId, 'review', { maxRuntimeMs, providers: request.reviewers });

  // Fire and forget — the work runs in the background
  executeReview(request, config, {
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

  const modeLabel = depth === 'thorough' ? 'Deep review' : 'Review';
  logger.info(`${modeLabel} started as background job ${runId}`);

  const reviewerList = request.reviewers.join(', ');
  const expectedDuration = depth === 'thorough' ? '5-20 minutes' : '1-2 minutes';
  return {
    content: [{
      type: 'text' as const,
      text: [
        `## ${modeLabel} Started`,
        ``,
        `**Run ID:** \`${runId}\``,
        `**Reviewers:** ${reviewerList}`,
        `**Mode:** ${depth}`,
        ``,
        `The review is running in the background. Use \`comparo_check\` with run ID \`${runId}\` to retrieve results.`,
        ``,
        `**Expected duration:** ${expectedDuration} depending on context size and number of reviewers.`,
        `**Polling guidance:** Wait at least 60 seconds before your first check. If still running, wait another 60 seconds before checking again.`,
      ].join('\n'),
    }],
  };
}

export async function handleReview(
  input: z.infer<typeof ReviewInputSchema>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  return launchReview(input, 'quick');
}

export async function handleDeepReview(
  input: z.infer<typeof ReviewInputSchema>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  return launchReview(input, 'thorough');
}

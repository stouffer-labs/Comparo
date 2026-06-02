import type { ReviewRequest, ProviderResponse, ProviderName, ComparoConfig, ProviderExecutionObserver } from '../types.js';
import { getProviders } from '../providers/registry.js';
import { generateReviewPacket } from '../utils/review-packet.js';
import { writeTextFile, getTempFilePath } from '../utils/file-ops.js';
import { analyzeResponses } from '../comparison/analyzer.js';
import { formatComparison } from '../comparison/formatter.js';
import { persistRun } from '../persistence/run-store.js';
import { logger } from '../utils/logger.js';

/**
 * Compute a safety-net timeout that scales with content size.
 *
 * Quick vs thorough is about SCOPE (instructions, tool access, context size),
 * not about killing the process on a clock.  Speed comes from scope constraints;
 * the timeout only catches stuck/runaway processes.
 *
 * Quick reviews use a 15 min base with lighter penalties and a 30 min cap.
 * Thorough reviews use a 20 min base with larger penalties and a 45 min cap.
 * Reviews are async (fire-and-forget with polling), so generous timeouts only
 * catch stuck processes; they do not block the caller.
 */
function computeReviewTimeout(
  baseTimeout: number,
  contextLength: number,
  fileCount: number,
  depth: ReviewRequest['depth'],
): number {
  const isThorough = depth === 'thorough';
  const agenticBase = Math.max(baseTimeout, isThorough ? 1_200_000 : 900_000);
  const filePenalty = fileCount * (isThorough ? 90_000 : 60_000);
  const contextPenalty = Math.floor(contextLength / 10_000) * (isThorough ? 90_000 : 60_000);
  return Math.min(agenticBase + filePenalty + contextPenalty, isThorough ? 2_700_000 : 1_800_000);
}

function computeProviderTimeout(
  scaledTimeout: number,
  depth: ReviewRequest['depth'],
  provider: ProviderName,
  configuredProviderTimeout?: number,
): number {
  const configuredTimeout = configuredProviderTimeout
    ? Math.max(configuredProviderTimeout, scaledTimeout)
    : scaledTimeout;

  if (depth !== 'thorough') {
    return configuredTimeout;
  }

  if (provider === 'codex') {
    return Math.max(configuredTimeout, 1_500_000);
  }

  if (provider === 'claude') {
    return Math.max(configuredTimeout, 1_200_000);
  }

  return configuredTimeout;
}

export function estimateReviewMaxRuntimeMs(
  request: ReviewRequest,
  config: ComparoConfig,
): number {
  const baseTimeout = config.defaults.timeout;
  const fileCount = request.contextFiles?.length ?? 0;
  const contextLength = request.context.length;
  const scaledTimeout = computeReviewTimeout(baseTimeout, contextLength, fileCount, request.depth);

  // Reviewers run in parallel; overall runtime is bounded by the slowest reviewer.
  const slowestProviderMs = request.reviewers.reduce((maxMs, reviewer) => {
    const reviewerTimeout = computeProviderTimeout(
      scaledTimeout,
      request.depth,
      reviewer,
      config.providers[reviewer].timeout,
    );
    return Math.max(maxMs, reviewerTimeout);
  }, 0);

  // Add small overhead for packet generation and result formatting/persistence.
  return slowestProviderMs + 30_000;
}

export async function executeReview(
  request: ReviewRequest,
  config: ComparoConfig,
  observer?: ProviderExecutionObserver,
): Promise<string> {
  logger.info(`Starting ${request.depth} review with reviewers: ${request.reviewers.join(', ')}`);

  // Generate and write review packet
  const packet = generateReviewPacket(request);
  const packetFile = getTempFilePath('review-request', '.md');
  await writeTextFile(packetFile, packet);

  // Scale timeout based on context size and depth — safety net, not speed enforcement
  const baseTimeout = config.defaults.timeout; // 300s default
  const fileCount = request.contextFiles?.length ?? 0;
  const contextLength = request.context.length;
  const scaledTimeout = computeReviewTimeout(baseTimeout, contextLength, fileCount, request.depth);

  logger.info(`Review timeout: ${(scaledTimeout / 1000).toFixed(0)}s (${fileCount} files, ${(contextLength / 1000).toFixed(1)}k chars context, mode=${request.depth})`);

  // Spawn all reviewers in parallel
  const providers = getProviders(request.reviewers, config);
  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      logger.info(`Invoking ${provider.name} for review...`);
      const providerTimeout = computeProviderTimeout(
        scaledTimeout,
        request.depth,
        provider.name,
        config.providers[provider.name].timeout,
      );
      await observer?.onProviderStart?.(provider.name, { timeoutMs: providerTimeout });
      try {
        const response = await provider.invokeViaFile(packetFile, {
          workingDirectory: process.cwd(),
          timeout: providerTimeout,
          excludeComparoMcp: true,
          safeMode: provider.name === 'codex' || config.safeMode,
          contextFileCount: fileCount,
          depth: request.depth,
          onActivity: (event) => observer?.onProviderActivity?.(provider.name, event),
        });
        if (response.error && !response.text.trim()) {
          await observer?.onProviderFail?.(provider.name, response.error);
        } else {
          await observer?.onProviderComplete?.(provider.name, response);
        }
        logger.info(`${provider.name} completed in ${response.durationMs}ms`);
        return response;
      } catch (error) {
        await observer?.onProviderFail?.(provider.name, String(error));
        throw error;
      }
    }),
  );

  // Collect responses and failures
  const responses: ProviderResponse[] = [];
  const successfulResponses: ProviderResponse[] = [];
  const failed: Array<{ provider: ProviderName; error: string }> = [];

  results.forEach((result, idx) => {
    const providerName = request.reviewers[idx];
    if (result.status === 'fulfilled') {
      responses.push(result.value);
      if (result.value.text.trim()) {
        successfulResponses.push(result.value);
      } else if (result.value.error) {
        failed.push({ provider: providerName, error: result.value.error });
      } else {
        failed.push({ provider: providerName, error: 'Empty response with no error message' });
      }
    } else {
      failed.push({ provider: providerName, error: String(result.reason) });
    }
  });

  if (successfulResponses.length === 0 && failed.length > 0) {
    const failReport = failed.map(f => `- **${f.provider}**: ${f.error}`).join('\n');
    return `## Cross-Validation Report\n\nNo successful responses received.\n\n### Failed Reviewers\n${failReport}`;
  }

  // Analyze and format
  const comparison = analyzeResponses(request.question, successfulResponses, failed);
  const markdown = formatComparison(comparison);

  // Persist run
  await persistRun({
    type: 'review',
    request,
    responses,
    comparisonMarkdown: markdown,
    comparisonData: comparison,
    maxRuns: config.defaults.maxRuns,
  });

  return markdown;
}

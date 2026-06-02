import type { RaceRequest, ProviderResponse, ProviderName, ComparoConfig, ProviderExecutionObserver } from '../types.js';
import { getProviders } from '../providers/registry.js';
import { formatRaceResults } from '../comparison/formatter.js';
import { persistRun } from '../persistence/run-store.js';
import { logger } from '../utils/logger.js';

const RACE_BASE_TIMEOUT_MS = 600_000;
const RACE_CAP_TIMEOUT_MS = 1_200_000;
const CLAUDE_RACE_MIN_TIMEOUT_MS = 720_000;
const CODEX_RACE_MIN_TIMEOUT_MS = 900_000;

function computeRaceTimeout(baseTimeout: number, promptLength: number): number {
  // Race prompts are sent directly (no file reading), but agentic providers
  // still need time for multiple turns. Base: 10 min, cap: 20 min.
  const agenticBase = Math.max(baseTimeout, RACE_BASE_TIMEOUT_MS);
  const promptPenalty = Math.floor(promptLength / 10_000) * 60_000;
  return Math.min(agenticBase + promptPenalty, RACE_CAP_TIMEOUT_MS);
}

function computeRaceProviderTimeout(
  scaledTimeout: number,
  provider: ProviderName,
  configuredProviderTimeout?: number,
): number {
  const configuredTimeout = configuredProviderTimeout
    ? Math.max(configuredProviderTimeout, scaledTimeout)
    : scaledTimeout;

  if (provider === 'codex') {
    return Math.max(configuredTimeout, CODEX_RACE_MIN_TIMEOUT_MS);
  }

  if (provider === 'claude') {
    return Math.max(configuredTimeout, CLAUDE_RACE_MIN_TIMEOUT_MS);
  }

  return configuredTimeout;
}

export function estimateRaceMaxRuntimeMs(
  request: RaceRequest,
  config: ComparoConfig,
): number {
  const scaledTimeout = computeRaceTimeout(config.defaults.timeout, request.prompt.length);
  const slowestProviderMs = request.models.reduce((maxMs, model) => {
    const providerTimeout = computeRaceProviderTimeout(
      scaledTimeout,
      model,
      config.providers[model].timeout,
    );
    return Math.max(maxMs, providerTimeout);
  }, 0);

  return slowestProviderMs + 30_000;
}

export async function executeRace(
  request: RaceRequest,
  config: ComparoConfig,
  observer?: ProviderExecutionObserver,
): Promise<string> {
  logger.info(`Starting race with models: ${request.models.join(', ')}`);

  const scaledTimeout = computeRaceTimeout(config.defaults.timeout, request.prompt.length);
  logger.info(`Race timeout: ${(scaledTimeout / 1000).toFixed(0)}s (${(request.prompt.length / 1000).toFixed(1)}k chars prompt)`);

  const providers = getProviders(request.models, config);
  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      logger.info(`Racing ${provider.name}...`);
      const providerTimeout = computeRaceProviderTimeout(
        scaledTimeout,
        provider.name,
        config.providers[provider.name].timeout,
      );
      await observer?.onProviderStart?.(provider.name, { timeoutMs: providerTimeout });
      try {
        const response = await provider.invoke({
          prompt: request.prompt,
          workingDirectory: process.cwd(),
          timeout: providerTimeout,
          excludeComparoMcp: true,
          safeMode: config.safeMode,
          onActivity: (event) => observer?.onProviderActivity?.(provider.name, event),
        });
        if (response.error && !response.text.trim()) {
          await observer?.onProviderFail?.(provider.name, response.error);
        } else {
          await observer?.onProviderComplete?.(provider.name, response);
        }
        logger.info(`${provider.name} finished in ${response.durationMs}ms`);
        return response;
      } catch (error) {
        await observer?.onProviderFail?.(provider.name, String(error));
        throw error;
      }
    }),
  );

  const responses: ProviderResponse[] = [];
  const failed: Array<{ provider: ProviderName; error: string }> = [];

  results.forEach((result, idx) => {
    const providerName = request.models[idx];
    if (result.status === 'fulfilled') {
      responses.push(result.value);
      if (result.value.error && !result.value.text) {
        failed.push({ provider: providerName, error: result.value.error });
      }
    } else {
      failed.push({ provider: providerName, error: String(result.reason) });
    }
  });

  const markdown = formatRaceResults(responses, failed);

  await persistRun({
    type: 'race',
    request,
    responses,
    comparisonMarkdown: markdown,
    maxRuns: config.defaults.maxRuns,
  });

  return markdown;
}

import { cosmiconfig } from 'cosmiconfig';
import { ComparoConfigSchema } from '../schemas.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { ComparoConfig } from '../types.js';
import { logger } from '../utils/logger.js';

let cachedConfig: ComparoConfig | null = null;

export async function loadConfig(): Promise<ComparoConfig> {
  if (cachedConfig) return cachedConfig;

  const explorer = cosmiconfig('comparo', {
    searchPlaces: [
      '.comparo/config.json',
      '.comparo/config.yaml',
      '.comparo/config.yml',
      'comparo.config.json',
      'package.json',
    ],
    searchStrategy: 'global',
  });

  try {
    const result = await explorer.search();
    if (result && result.config) {
      logger.debug(`Loaded config from ${result.filepath}`);
      const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, result.config as Record<string, unknown>);
      const parsed = ComparoConfigSchema.safeParse(merged);
      if (parsed.success) {
        cachedConfig = parsed.data;
        return cachedConfig;
      }
      logger.warn(`Invalid config at ${result.filepath}: ${parsed.error.message}`);
    }
  } catch (error) {
    logger.debug(`No config found, using defaults`);
  }

  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

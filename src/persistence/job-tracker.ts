import { join } from 'node:path';
import { getRunsDir, ensureDir, writeJsonFile, generateRunId } from '../utils/file-ops.js';
import { appendFile, readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import type { ProviderName } from '../types.js';

export type JobStatus = 'running' | 'completed' | 'failed';
export type ProviderJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ProviderJobState {
  status: ProviderJobStatus;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  timeoutMs?: number;
  error?: string;
}

export interface JobState {
  runId: string;
  type: 'review' | 'race' | 'consolidate';
  status: JobStatus;
  startedAt: number;
  lastActivityAt?: number;
  maxRuntimeMs?: number;
  completedAt?: number;
  elapsedMs?: number;
  result?: string;
  error?: string;
  providers?: Partial<Record<ProviderName, ProviderJobState>>;
}

export interface StartJobOptions {
  maxRuntimeMs?: number;
  providers?: ProviderName[];
}

// In-memory cache for fast lookups during current server lifetime
const jobs = new Map<string, JobState>();

const STATUS_FILE = 'status.json';
const EVENTS_FILE = 'events.log';

export function createJobId(): string {
  return generateRunId();
}

export async function startJob(
  runId: string,
  type: JobState['type'],
  opts: StartJobOptions = {},
): Promise<JobState> {
  const startedAt = Date.now();
  const state: JobState = {
    runId,
    type,
    status: 'running',
    startedAt,
    lastActivityAt: startedAt,
    maxRuntimeMs: opts.maxRuntimeMs,
    elapsedMs: 0,
    providers: Object.fromEntries(
      (opts.providers ?? []).map((provider) => [provider, { status: 'pending' }]),
    ) as Partial<Record<ProviderName, ProviderJobState>>,
  };

  jobs.set(runId, state);
  await persistStatus(runId, state);
  await appendJobEvent(runId, `Job started (${type})${formatRuntimeHint(opts.maxRuntimeMs)}`);
  logger.info(`Job ${runId} started (${type})`);
  return state;
}

export async function startProvider(
  runId: string,
  provider: ProviderName,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const state = await getCachedOrDiskState(runId);
  if (!state) return;

  const now = Date.now();
  const providerState = state.providers?.[provider] ?? { status: 'pending' as const };
  state.providers = state.providers ?? {};
  state.providers[provider] = {
    ...providerState,
    status: 'running',
    startedAt: providerState.startedAt ?? now,
    lastActivityAt: now,
    timeoutMs: opts.timeoutMs ?? providerState.timeoutMs,
    error: undefined,
  };
  state.lastActivityAt = now;

  await persistStatus(runId, state);
  await appendJobEvent(
    runId,
    `Provider ${provider} started${opts.timeoutMs ? ` (timeout ${Math.round(opts.timeoutMs / 1000)}s)` : ''}`,
  );
}

export async function recordProviderActivity(
  runId: string,
  provider: ProviderName,
): Promise<void> {
  const state = await getCachedOrDiskState(runId);
  if (!state) return;

  const now = Date.now();
  state.providers = state.providers ?? {};
  const providerState = state.providers[provider] ?? { status: 'running' as const, startedAt: now };
  state.providers[provider] = {
    ...providerState,
    status: providerState.status === 'pending' ? 'running' : providerState.status,
    startedAt: providerState.startedAt ?? now,
    lastActivityAt: now,
  };
  state.lastActivityAt = now;
}

export async function completeProvider(
  runId: string,
  provider: ProviderName,
): Promise<void> {
  const state = await getCachedOrDiskState(runId);
  if (!state) return;

  const now = Date.now();
  state.providers = state.providers ?? {};
  const providerState = state.providers[provider] ?? { status: 'running' as const, startedAt: now };
  state.providers[provider] = {
    ...providerState,
    status: 'completed',
    startedAt: providerState.startedAt ?? now,
    lastActivityAt: now,
    completedAt: now,
    elapsedMs: now - (providerState.startedAt ?? now),
    error: undefined,
  };
  state.lastActivityAt = now;

  await persistStatus(runId, state);
  await appendJobEvent(
    runId,
    `Provider ${provider} completed in ${((state.providers[provider]?.elapsedMs ?? 0) / 1000).toFixed(1)}s`,
  );
}

export async function failProvider(
  runId: string,
  provider: ProviderName,
  error: string,
): Promise<void> {
  const state = await getCachedOrDiskState(runId);
  if (!state) return;

  const now = Date.now();
  state.providers = state.providers ?? {};
  const providerState = state.providers[provider] ?? { status: 'running' as const, startedAt: now };
  state.providers[provider] = {
    ...providerState,
    status: 'failed',
    startedAt: providerState.startedAt ?? now,
    lastActivityAt: now,
    completedAt: now,
    elapsedMs: now - (providerState.startedAt ?? now),
    error,
  };
  state.lastActivityAt = now;

  await persistStatus(runId, state);
  await appendJobEvent(
    runId,
    `Provider ${provider} failed after ${((state.providers[provider]?.elapsedMs ?? 0) / 1000).toFixed(1)}s: ${error}`,
    'warn',
  );
}

export async function completeJob(runId: string, result: string): Promise<void> {
  const state = await getCachedOrDiskState(runId);
  if (!state) {
    logger.warn(`completeJob: unknown runId ${runId}`);
    return;
  }

  state.status = 'completed';
  state.completedAt = Date.now();
  state.elapsedMs = state.completedAt - state.startedAt;
  state.result = result;

  await persistStatus(runId, state);
  await appendJobEvent(runId, `Job completed in ${(state.elapsedMs / 1000).toFixed(1)}s`);
  logger.info(`Job ${runId} completed in ${(state.elapsedMs / 1000).toFixed(1)}s`);
}

export async function failJob(runId: string, error: string): Promise<void> {
  const state = await getCachedOrDiskState(runId);
  if (!state) {
    logger.warn(`failJob: unknown runId ${runId}`);
    return;
  }

  state.status = 'failed';
  state.completedAt = Date.now();
  state.elapsedMs = state.completedAt - state.startedAt;
  state.error = error;

  await persistStatus(runId, state);
  await appendJobEvent(runId, `Job failed after ${(state.elapsedMs / 1000).toFixed(1)}s: ${error}`, 'warn');
  logger.info(`Job ${runId} failed after ${(state.elapsedMs / 1000).toFixed(1)}s: ${error}`);
}

export async function getJobState(runId: string): Promise<JobState | null> {
  // Try in-memory first
  const cached = jobs.get(runId);
  if (cached) {
    // Update elapsed time for running jobs
    if (cached.status === 'running') {
      cached.elapsedMs = Date.now() - cached.startedAt;
    }
    return cached;
  }

  // Fall back to disk (for jobs from a previous server lifetime)
  return loadStatus(runId);
}

export function getLatestRunId(): string | null {
  let latest: JobState | null = null;
  for (const state of jobs.values()) {
    if (!latest || state.startedAt > latest.startedAt) {
      latest = state;
    }
  }
  return latest?.runId ?? null;
}

async function persistStatus(runId: string, state: JobState): Promise<void> {
  try {
    const runDir = join(getRunsDir(), runId);
    await ensureDir(runDir);
    await writeJsonFile(join(runDir, STATUS_FILE), state);
  } catch (err) {
    logger.warn(`Failed to persist job status: ${err}`);
  }
}

async function loadStatus(runId: string): Promise<JobState | null> {
  try {
    const filePath = join(getRunsDir(), runId, STATUS_FILE);
    const raw = await readFile(filePath, 'utf-8');
    const state = JSON.parse(raw) as JobState;
    // Cache it for future lookups
    jobs.set(runId, state);
    return state;
  } catch {
    return null;
  }
}

async function getCachedOrDiskState(runId: string): Promise<JobState | null> {
  const cached = jobs.get(runId);
  if (cached) return cached;
  return loadStatus(runId);
}

async function appendJobEvent(runId: string, message: string, level: 'info' | 'warn' = 'info'): Promise<void> {
  try {
    const runDir = join(getRunsDir(), runId);
    await ensureDir(runDir);
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}\n`;
    await appendFile(join(runDir, EVENTS_FILE), line, 'utf-8');
  } catch (err) {
    logger.warn(`Failed to append job event: ${err}`);
  }
}

function formatRuntimeHint(maxRuntimeMs?: number): string {
  if (!maxRuntimeMs || maxRuntimeMs <= 0) return '';
  return `, max runtime ${Math.round(maxRuntimeMs / 1000)}s`;
}

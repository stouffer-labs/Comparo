import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const COMPARO_DIR = '.comparo';

export function getComparoDir(workingDir?: string): string {
  return join(workingDir ?? process.cwd(), COMPARO_DIR);
}

export function getRunsDir(workingDir?: string): string {
  return join(getComparoDir(workingDir), 'runs');
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(join(filePath, '..'));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(join(filePath, '..'));
  await writeFile(filePath, content, 'utf-8');
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const short = randomUUID().slice(0, 8);
  return `${date}-${time}-${short}`;
}

export function getTempFilePath(prefix: string, ext: string, workingDir?: string): string {
  return join(getComparoDir(workingDir), `${prefix}-${randomUUID().slice(0, 8)}${ext}`);
}

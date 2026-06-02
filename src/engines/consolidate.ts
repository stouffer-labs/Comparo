import type { ConsolidateRequest } from '../types.js';
import { logger } from '../utils/logger.js';

export async function executeConsolidate(
  request: ConsolidateRequest,
): Promise<string> {
  logger.info(`Consolidating session context as ${request.format}`);

  if (request.format === 'transfer_packet') {
    return generateTransferPacket(request.context);
  }

  return generatePrompt(request.context);
}

function generateTransferPacket(context: string): string {
  return [
    '# Session Transfer Packet',
    '',
    '## Purpose',
    'This packet captures the key context from a prior AI session for seamless handoff.',
    '',
    '## Session Context',
    '',
    context,
    '',
    '## Instructions for Receiving AI',
    '',
    '1. Read this packet carefully before proceeding',
    '2. Do NOT re-do work already completed — build on it',
    '3. If anything is unclear, ask clarifying questions',
    '4. Reference specific files and decisions mentioned above',
  ].join('\n');
}

function generatePrompt(context: string): string {
  return [
    'Continue working on the following task. Here is the context from a prior session:',
    '',
    context,
    '',
    'Pick up where this left off. Do not repeat completed work.',
  ].join('\n');
}

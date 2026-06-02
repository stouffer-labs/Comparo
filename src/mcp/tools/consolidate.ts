import { z } from 'zod';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ConsolidateInputSchema } from '../../schemas.js';
import { executeConsolidate } from '../../engines/consolidate.js';
import { withProgressHeartbeat } from '../../utils/progress.js';
import { logger } from '../../utils/logger.js';
import type { ConsolidateRequest } from '../../types.js';

export const consolidateToolDefinition = {
  name: 'comparo_consolidate',
  description:
    'Consolidate session context into a transfer packet or prompt for handing off to another AI.',
  inputSchema: ConsolidateInputSchema,
};

export async function handleConsolidate(
  input: z.infer<typeof ConsolidateInputSchema>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  logger.info('comparo_consolidate invoked');

  const request: ConsolidateRequest = {
    context: input.context,
    format: input.format,
  };

  const result = await withProgressHeartbeat(
    extra,
    'Consolidating session',
    () => executeConsolidate(request),
  );

  return {
    content: [{ type: 'text' as const, text: result }],
  };
}

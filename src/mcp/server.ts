import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { reviewToolDefinition, deepReviewToolDefinition, handleReview, handleDeepReview } from './tools/review.js';
import { raceToolDefinition, handleRace } from './tools/race.js';
import { consolidateToolDefinition, handleConsolidate } from './tools/consolidate.js';
import { checkToolDefinition, handleCheck } from './tools/check.js';
import { logger } from '../utils/logger.js';

export function checkLoopPrevention(): boolean {
  if (process.env.COMPARO_IS_REVIEWER === '1') {
    logger.debug('COMPARO_IS_REVIEWER=1 detected, refusing to start MCP server (loop prevention)');
    return true;
  }
  return false;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'comparo',
    version: '0.1.0',
  });

  // Register comparo_review (async — returns run ID immediately)
  server.tool(
    reviewToolDefinition.name,
    reviewToolDefinition.description,
    reviewToolDefinition.inputSchema.shape,
    async (input, extra) => handleReview(input, extra),
  );

  // Register comparo_deep_review (async — returns run ID immediately)
  server.tool(
    deepReviewToolDefinition.name,
    deepReviewToolDefinition.description,
    deepReviewToolDefinition.inputSchema.shape,
    async (input, extra) => handleDeepReview(input, extra),
  );

  // Register comparo_race (async — returns run ID immediately)
  server.tool(
    raceToolDefinition.name,
    raceToolDefinition.description,
    raceToolDefinition.inputSchema.shape,
    async (input, extra) => handleRace(input, extra),
  );

  // Register comparo_check (poll for results)
  server.tool(
    checkToolDefinition.name,
    checkToolDefinition.description,
    checkToolDefinition.inputSchema.shape,
    async (input) => handleCheck(input),
  );

  // Register comparo_consolidate (fast, stays synchronous)
  server.tool(
    consolidateToolDefinition.name,
    consolidateToolDefinition.description,
    consolidateToolDefinition.inputSchema.shape,
    async (input, extra) => handleConsolidate(input, extra),
  );

  return server;
}

export async function startServer(): Promise<void> {
  if (checkLoopPrevention()) {
    process.exit(0);
  }

  const server = createServer();
  const transport = new StdioServerTransport();

  logger.info('Starting comparo MCP server...');
  await server.connect(transport);
  logger.info('Comparo MCP server connected via stdio');
}

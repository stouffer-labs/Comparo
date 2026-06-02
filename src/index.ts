import { startServer } from './mcp/server.js';

// Direct entry point: `node dist/src/index.js` starts the MCP server
startServer().catch((error) => {
  console.error('[comparo] Fatal error:', error);
  process.exit(1);
});

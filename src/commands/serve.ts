import { startServer } from '../mcp/server.js';

export async function runServe(): Promise<void> {
  await startServer();
}

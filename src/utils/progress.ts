import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { logger } from './logger.js';

const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds — well under typical 60s timeouts

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Runs an async operation while sending periodic MCP notifications to prevent
 * client-side timeouts. Uses two strategies:
 *
 * 1. notifications/progress — if the client sent a progressToken (resets timeout per spec)
 * 2. notifications/message (logging) — always sent, keeps stdio pipe active
 */
export async function withProgressHeartbeat<T>(
  extra: Extra,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  let tick = 0;

  const interval = setInterval(async () => {
    tick++;
    const elapsed = tick * 10;

    // Strategy 1: progress notification (if client supports it)
    if (progressToken) {
      try {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: tick,
            total: 0,
            message: `${label} (${elapsed}s elapsed)`,
          },
        } as ServerNotification);
      } catch {
        // Client may not support progress
      }
    }

    // Strategy 2: logging notification (universally supported, keeps stdio active)
    try {
      await extra.sendNotification({
        method: 'notifications/message',
        params: {
          level: 'info',
          logger: 'comparo',
          data: `${label} — ${elapsed}s elapsed, still working...`,
        },
      } as ServerNotification);
    } catch {
      // Non-critical
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}

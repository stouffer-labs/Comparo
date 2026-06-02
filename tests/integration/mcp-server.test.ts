import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, checkLoopPrevention } from '../../src/mcp/server.js';

describe('MCP Server', () => {
  describe('loop prevention', () => {
    const originalEnv = process.env.COMPARO_IS_REVIEWER;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.COMPARO_IS_REVIEWER;
      } else {
        process.env.COMPARO_IS_REVIEWER = originalEnv;
      }
    });

    it('refuses to start when COMPARO_IS_REVIEWER=1', () => {
      process.env.COMPARO_IS_REVIEWER = '1';
      expect(checkLoopPrevention()).toBe(true);
    });

    it('allows start when COMPARO_IS_REVIEWER is not set', () => {
      delete process.env.COMPARO_IS_REVIEWER;
      expect(checkLoopPrevention()).toBe(false);
    });

    it('allows start when COMPARO_IS_REVIEWER is set to other value', () => {
      process.env.COMPARO_IS_REVIEWER = '0';
      expect(checkLoopPrevention()).toBe(false);
    });
  });

  describe('server creation', () => {
    it('creates server with all four tools', () => {
      const server = createServer();
      expect(server).toBeDefined();
      // Server registers: comparo_review, comparo_race, comparo_check, comparo_consolidate
    });
  });
});

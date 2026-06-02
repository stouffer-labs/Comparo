import { Command } from 'commander';
import { runServe } from './commands/serve.js';
import { runDoctor } from './commands/doctor.js';
import { runSetup } from './commands/setup.js';

const program = new Command();
const mcp = program.command('mcp').description('MCP server commands');

program
  .name('comparo')
  .description('MCP server for cross-validation across Claude, Gemini, and Codex CLIs')
  .version('0.1.0');

program
  .command('serve')
  .description('Start the comparo MCP server on stdio')
  .action(async () => {
    await runServe();
  });

program
  .command('setup')
  .description('Auto-configure comparo MCP server in all detected CLIs')
  .option('--dry-run', 'Show what would be configured without making changes', false)
  .action(async (opts: { dryRun: boolean }) => {
    await runSetup(opts.dryRun);
  });

mcp
  .command('serve')
  .description('Start the comparo MCP server on stdio')
  .action(async () => {
    await runServe();
  });

mcp
  .command('install')
  .alias('setup')
  .description('Register comparo MCP server in detected CLIs')
  .option('--dry-run', 'Show what would be configured without making changes', false)
  .action(async (opts: { dryRun: boolean }) => {
    await runSetup(opts.dryRun);
  });

program
  .command('doctor')
  .description('Check health of all CLI providers')
  .action(async () => {
    await runDoctor();
  });

program.parse();

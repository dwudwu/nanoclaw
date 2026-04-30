/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Tool modules are loaded conditionally based on the `capabilities`
 * array in container.json. If `capabilities` is null/absent, all
 * modules load (backward compatible). If present, only listed modules
 * are imported alongside `core` (which always loads).
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, add its capability key below, and append it to
 * OPTIONAL_MODULES.
 */
import { loadConfig } from '../config.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const OPTIONAL_MODULES: Record<string, string> = {
  scheduling: './scheduling.js',
  interactive: './interactive.js',
  agents: './agents.js',
  'self-mod': './self-mod.js',
  whatsapp: './whatsapp.js',
  attachments: './attachments.js',
};

async function loadTools(): Promise<void> {
  // Core tools always load
  await import('./core.js');

  const config = loadConfig();
  const caps = config.capabilities;

  if (caps === null) {
    // No capabilities specified — load everything (backward compatible)
    for (const mod of Object.values(OPTIONAL_MODULES)) {
      await import(mod);
    }
  } else {
    for (const cap of caps) {
      const mod = OPTIONAL_MODULES[cap];
      if (mod) {
        await import(mod);
      } else {
        log(`Unknown capability "${cap}", skipping`);
      }
    }
  }
}

loadTools()
  .then(() => startMcpServer())
  .catch((err) => {
    log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

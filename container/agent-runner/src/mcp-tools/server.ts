/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import fs from 'fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

/**
 * The MCP server runs as a child of the Claude Agent SDK (stdio transport),
 * and the SDK swallows the child's stderr — so `console.error` from here
 * never reaches `docker logs`. To make tool calls observable from the host,
 * we ALSO append to a file in the session bind-mount at `/workspace`, which
 * shows up on the host at `data/v2-sessions/<ag>/<session>/.mcp-tool-calls.log`.
 */
const TOOL_CALL_LOG = '/workspace/.mcp-tool-calls.log';

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(`[mcp-tools] ${msg}`);
  try {
    fs.appendFileSync(TOOL_CALL_LOG, `${line}\n`);
  } catch {
    // Best-effort. The mount may not exist in some test contexts.
  }
}

/**
 * Truncate a tool's args to a single short line for the call log.
 * Args may contain large bodies (memo content, scheduled task prompts) that
 * would dominate `docker logs` output if printed in full. Stays well below
 * stdio buffer thresholds and never logs auth-bearing fields verbatim — those
 * tools can override the preview by returning their own log line if needed.
 */
function previewArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return '';
  }
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      log(`call ${name} → UNKNOWN TOOL`);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    const t0 = Date.now();
    log(`call ${name} ${previewArgs(args)}`);
    try {
      const result = await tool.handler(args ?? {});
      const dur = Date.now() - t0;
      log(`done ${name} (${dur}ms)${result.isError ? ' [error]' : ''}`);
      return result;
    } catch (err) {
      const dur = Date.now() - t0;
      log(`fail ${name} (${dur}ms): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}

/**
 * WhatsApp-specific MCP tools: register_group, available_groups.
 *
 * register_group: fire-and-forget system action — the host creates the
 *   messaging_groups + messaging_group_agents rows in v2.db, creates the
 *   groups/{folder}/ directory, and sends back a success or failure message.
 *
 * available_groups: reads /workspace/ipc/available_groups.json if the file
 *   exists and is less than 5 minutes old. Otherwise fires a
 *   get_available_groups system action so the host fetches from the live
 *   WhatsApp socket, writes the file, and sends back the list as a message.
 */
import fs from 'fs';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const AVAILABLE_GROUPS_PATH = '/workspace/ipc/available_groups.json';
const AVAILABLE_GROUPS_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const registerGroup: McpToolDefinition = {
  tool: {
    name: 'register_group',
    description:
      'Register a WhatsApp group so the agent can receive and respond to messages from it. ' +
      'Writes to the central DB and creates the group folder on the host. ' +
      'Fire-and-forget — you will receive a success or failure message when complete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        jid: {
          type: 'string',
          description: 'WhatsApp group JID (e.g. 120363123456789012@g.us)',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the group',
        },
        folder: {
          type: 'string',
          description: 'Folder name for the group on disk (groups/{folder}/). Alphanumeric, hyphens, underscores only.',
        },
        trigger: {
          type: 'string',
          description: 'Regex pattern that triggers the agent (e.g. "nano|@nano"). Required when requiresTrigger is true.',
        },
        requiresTrigger: {
          type: 'boolean',
          description: 'If true, the agent only responds when the trigger pattern matches. If false, it responds to every message.',
        },
        isMain: {
          type: 'boolean',
          description: 'Optional. If true, this group is treated as the primary group (higher priority).',
        },
      },
      required: ['jid', 'name', 'folder', 'trigger', 'requiresTrigger'],
    },
  },
  async handler(args) {
    const jid = args.jid as string;
    const name = args.name as string;
    const folder = args.folder as string;
    const trigger = args.trigger as string;
    const requiresTrigger = args.requiresTrigger as boolean;
    const isMain = (args.isMain as boolean | undefined) ?? false;

    if (!jid || !name || !folder) return err('jid, name, and folder are required');
    if (!/^[a-zA-Z0-9_-]+$/.test(folder)) return err('folder must contain only alphanumeric characters, hyphens, and underscores');
    if (!jid.endsWith('@g.us') && !jid.endsWith('@s.whatsapp.net')) {
      return err('jid must be a valid WhatsApp JID (ending in @g.us for groups or @s.whatsapp.net for DMs)');
    }
    if (requiresTrigger && !trigger) return err('trigger is required when requiresTrigger is true');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'register_group',
        jid,
        name,
        folder,
        trigger,
        requiresTrigger,
        isMain,
      }),
    });

    return ok(
      `Group registration requested for "${name}" (${jid}). ` +
        `You will receive a confirmation message when complete.`,
    );
  },
};

export const availableGroups: McpToolDefinition = {
  tool: {
    name: 'available_groups',
    description:
      'List WhatsApp groups the connected account can see. ' +
      'Returns cached data immediately if available (< 5 min old). ' +
      'Otherwise requests a fresh fetch from the host — the list will arrive as a follow-up message.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler(_args) {
    // Try reading a fresh cached file first.
    try {
      const stat = fs.statSync(AVAILABLE_GROUPS_PATH);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < AVAILABLE_GROUPS_TTL_MS) {
        const raw = fs.readFileSync(AVAILABLE_GROUPS_PATH, 'utf-8');
        const groups = JSON.parse(raw) as Array<{ jid: string; name: string }>;
        if (groups.length === 0) {
          return ok('No WhatsApp groups found. Make sure the connected account is a member of at least one group.');
        }
        const lines = groups.map((g) => `• ${g.name} — \`${g.jid}\``).join('\n');
        return ok(`Available WhatsApp groups (${groups.length}):\n\n${lines}`);
      }
    } catch {
      // File doesn't exist or is unreadable — fall through to system action.
    }

    // Request a fresh fetch from the host.
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'get_available_groups' }),
    });

    return ok(
      'Fetching the list of available WhatsApp groups from the host. ' +
        'The list will arrive as a follow-up message in a moment. ' +
        'Call this tool again after receiving it to get the cached data inline.',
    );
  },
};

registerTools([registerGroup, availableGroups]);

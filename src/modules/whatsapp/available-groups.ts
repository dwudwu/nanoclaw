/**
 * Delivery action handler for the `get_available_groups` system action.
 *
 * Fetches the WhatsApp groups the connected account can see via the live
 * adapter socket, writes the result to the session's IPC folder so the
 * container can read it synchronously on subsequent calls, and sends the
 * formatted list back as a chat message.
 */
import fs from 'fs';
import path from 'path';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { DeliveryActionHandler } from '../../delivery.js';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const handleGetAvailableGroups: DeliveryActionHandler = async (_content, session) => {
  const reply = (text: string) => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `avail-groups-reply-${generateId()}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  const adapter = getChannelAdapter('whatsapp');
  if (!adapter) {
    reply('WhatsApp adapter is not active. Make sure WhatsApp is installed and connected.');
    return;
  }

  if (!adapter.syncConversations) {
    reply('WhatsApp adapter does not support listing groups.');
    return;
  }

  try {
    const conversations = await adapter.syncConversations();
    const groups = conversations
      .filter((c) => c.isGroup)
      .map((c) => ({ jid: c.platformId, name: c.name }));

    // Write to the session IPC folder so the container can read it directly.
    const ipcDir = path.join(sessionDir(session.agent_group_id, session.id), 'ipc');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(ipcDir, 'available_groups.json'), JSON.stringify(groups, null, 2));

    if (groups.length === 0) {
      reply('No WhatsApp groups found. The connected account is not a member of any groups.');
      return;
    }

    const lines = groups.map((g) => `• ${g.name} — \`${g.jid}\``).join('\n');
    reply(`Available WhatsApp groups (${groups.length}):\n\n${lines}\n\nUse the JID with \`register_group\` to wire a group to this agent.`);

    log.info('get_available_groups: fetched and wrote groups', {
      sessionId: session.id,
      count: groups.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('get_available_groups failed', { sessionId: session.id, err: e });
    reply(`Failed to fetch WhatsApp groups: ${msg}`);
  }
};

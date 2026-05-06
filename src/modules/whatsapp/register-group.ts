/**
 * Delivery action handler for the `register_group` system action.
 *
 * Wires a WhatsApp group JID to the requesting session's agent group:
 *   1. Upsert a messaging_groups row for the JID.
 *   2. Upsert a messaging_group_agents row wiring it to the current agent group.
 *   3. Create groups/{folder}/ on disk if it doesn't exist.
 *   4. Send back a success or failure message to the session.
 *
 * engage_mode logic:
 *   requiresTrigger=true  → 'pattern' mode with engage_pattern=trigger
 *   requiresTrigger=false → 'pattern' mode with engage_pattern='.' (match all)
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { DeliveryActionHandler } from '../../delivery.js';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const handleRegisterGroup: DeliveryActionHandler = async (content, session) => {
  const jid = content.jid as string | undefined;
  const name = content.name as string | undefined;
  const folder = content.folder as string | undefined;
  const trigger = (content.trigger as string | undefined) ?? '';
  const requiresTrigger = Boolean(content.requiresTrigger);
  const isMain = Boolean(content.isMain);

  const reply = (text: string) => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `reg-group-reply-${generateId()}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  if (!jid || !name || !folder) {
    reply('register_group failed: jid, name, and folder are required.');
    return;
  }

  try {
    // 1. Resolve or create the agent group for this folder.
    let agentGroup = getAgentGroupByFolder(folder);
    if (!agentGroup) {
      agentGroup = {
        id: `ag-${generateId()}`,
        name,
        folder,
        agent_provider: null,
        created_at: new Date().toISOString(),
      };
      createAgentGroup(agentGroup);
      initGroupFilesystem(agentGroup);
      log.info('Created new agent group for WhatsApp group', { folder, name });
    }

    // 2. Upsert messaging_groups row for this JID.
    let mg = getMessagingGroupByPlatform('whatsapp', jid);
    if (!mg) {
      mg = {
        id: `mg-${generateId()}`,
        channel_type: 'whatsapp',
        platform_id: jid,
        name,
        is_group: jid.endsWith('@g.us') ? 1 : 0,
        unknown_sender_policy: 'request_approval',
        created_at: new Date().toISOString(),
      };
      createMessagingGroup(mg);
      log.info('Created messaging group for WhatsApp JID', { jid, name });
    }

    // 3. Upsert messaging_group_agents wiring.
    const existing = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
    if (!existing) {
      const engagePattern = requiresTrigger ? trigger : '.';
      createMessagingGroupAgent({
        id: `mga-${generateId()}`,
        messaging_group_id: mg.id,
        agent_group_id: agentGroup.id,
        engage_mode: 'pattern',
        engage_pattern: engagePattern,
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: isMain ? 1 : 0,
        created_at: new Date().toISOString(),
      });
      log.info('Wired WhatsApp group to agent group', {
        jid,
        agentGroupId: agentGroup.id,
        engagePattern,
      });
    }

    // 4. Ensure the group folder exists on disk.
    const groupDir = path.resolve(GROUPS_DIR, folder);
    if (!fs.existsSync(groupDir)) {
      fs.mkdirSync(groupDir, { recursive: true });
    }

    const status = existing ? 'already registered' : 'registered';
    reply(
      `WhatsApp group "${name}" (${jid}) ${status} successfully.\n` +
        `Folder: groups/${folder}/\n` +
        `Trigger: ${requiresTrigger ? `pattern "${trigger}"` : 'always (no trigger required)'}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('register_group action failed', { jid, err: e });
    reply(`register_group failed: ${msg}`);
  }
};

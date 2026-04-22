import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export interface MediaItem {
  type: 'image' | 'video' | 'audio';
  path: string;
  caption?: string;
}

/**
 * Extract <send_media> tags from agent output.
 * Returns the cleaned text (tags removed) and the list of media items.
 * Tag format: <send_media type="image|video|audio" path="/workspace/group/..." caption="optional" />
 */
export function extractMediaTags(text: string): { text: string; media: MediaItem[] } {
  const media: MediaItem[] = [];
  const cleaned = text
    .replace(/<send_media\s+([^>]*?)\/>/g, (_, attrs) => {
      const typeMatch = attrs.match(/type="([^"]+)"/);
      const pathMatch = attrs.match(/path="([^"]+)"/);
      const captionMatch = attrs.match(/caption="([^"]*)"/);
      const type = typeMatch?.[1];
      const filePath = pathMatch?.[1];
      if (filePath && (type === 'image' || type === 'video' || type === 'audio')) {
        media.push({ type, path: filePath, caption: captionMatch?.[1] });
      }
      return '';
    })
    .trim();
  return { text: cleaned, media };
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

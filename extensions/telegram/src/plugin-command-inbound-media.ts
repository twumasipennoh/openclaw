import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";
import type { PluginCommandContext } from "openclaw/plugin-sdk/channel-core";

type TelegramMessage = NonNullable<Context["message"]>;
type PluginCommandAttachment = NonNullable<PluginCommandContext["attachments"]>[number];
type PluginCommandReplyTo = NonNullable<PluginCommandContext["replyTo"]>;

export type PluginCommandInboundMedia = {
  attachments: PluginCommandAttachment[];
  replyTo: PluginCommandReplyTo | null;
  structured: string;
};

const inboundMediaDir = () => path.join(os.homedir(), ".openclaw", "media", "inbound");

/**
 * Downloads media from a plugin-command message (and the message it replies to)
 * and formats contact/location/venue/poll shares, so plugin handlers can see them.
 */
export async function collectPluginCommandInboundMedia(params: {
  bot: Bot;
  msg: TelegramMessage;
  warn?: (message: string) => void;
}): Promise<PluginCommandInboundMedia> {
  const { bot, msg } = params;
  const attachments: PluginCommandAttachment[] = [];

  const download = async (
    fileId: string,
    mime: string,
    originalName: string | null,
    fromReply: boolean,
  ) => {
    try {
      const file = await bot.api.getFile(fileId);
      if (!file?.file_path) {
        return;
      }
      const resp = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
      if (!resp.ok) {
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      const dir = inboundMediaDir();
      await fs.mkdir(dir, { recursive: true });
      const ext = file.file_path.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "";
      const name = `${Date.now()}-${fileId.slice(-8)}${ext}`;
      const filePath = path.join(dir, name);
      await fs.writeFile(filePath, buf);
      attachments.push({ path: filePath, mime, originalName: originalName || name, fromReply });
    } catch {
      // One failed download shouldn't drop the rest.
    }
  };

  const scan = async (src: TelegramMessage | undefined, fromReply: boolean) => {
    if (!src) {
      return;
    }
    if (Array.isArray(src.photo) && src.photo.length > 0) {
      await download(src.photo[src.photo.length - 1].file_id, "image/jpeg", null, fromReply);
    }
    if (src.animation?.file_id) {
      await download(
        src.animation.file_id,
        src.animation.mime_type || "video/mp4",
        src.animation.file_name || null,
        fromReply,
      );
    }
    if (src.video?.file_id) {
      await download(
        src.video.file_id,
        src.video.mime_type || "video/mp4",
        src.video.file_name || null,
        fromReply,
      );
    }
    if (src.video_note?.file_id) {
      await download(src.video_note.file_id, "video/mp4", null, fromReply);
    }
    if (src.document?.file_id) {
      await download(
        src.document.file_id,
        src.document.mime_type || "application/octet-stream",
        src.document.file_name || null,
        fromReply,
      );
    }
    if (src.voice?.file_id) {
      await download(src.voice.file_id, src.voice.mime_type || "audio/ogg", null, fromReply);
    }
    if (src.audio?.file_id) {
      await download(
        src.audio.file_id,
        src.audio.mime_type || "audio/mpeg",
        src.audio.file_name || null,
        fromReply,
      );
    }
    if (src.sticker?.file_id) {
      const sticker = src.sticker;
      const mime = sticker.is_video
        ? "video/webm"
        : sticker.is_animated
          ? "application/x-tgsticker"
          : "image/webp";
      const name = sticker.set_name ? `sticker-${sticker.set_name}-${sticker.emoji || "x"}` : null;
      await download(sticker.file_id, mime, name, fromReply);
    }
  };

  try {
    await scan(msg, false);
    await scan(msg.reply_to_message as TelegramMessage | undefined, true);
  } catch (err) {
    params.warn?.(`inbound-media: ${err instanceof Error ? err.message : String(err)}`);
  }

  let replyTo: PluginCommandReplyTo | null = null;
  const reply = msg.reply_to_message as TelegramMessage | undefined;
  if (reply) {
    const text =
      (typeof reply.text === "string" && reply.text) ||
      (typeof reply.caption === "string" && reply.caption) ||
      null;
    const fromUser = reply.from ? reply.from.username || reply.from.first_name || null : null;
    const hasMedia = Boolean(
      reply.photo ||
      reply.video ||
      reply.video_note ||
      reply.animation ||
      reply.document ||
      reply.voice ||
      reply.audio ||
      reply.sticker,
    );
    const structured = formatStructuredShares(reply);
    if (text || fromUser || hasMedia || structured) {
      replyTo = {
        text,
        fromUser,
        messageId: reply.message_id,
        hasMedia,
        fromBot: Boolean(reply.from?.is_bot),
        structured,
      };
    }
  }

  return { attachments, replyTo, structured: formatStructuredShares(msg) };
}

/** Formats contact/location/venue/poll shares as one plain-text line each. */
export function formatStructuredShares(src: TelegramMessage | undefined): string {
  if (!src) {
    return "";
  }
  const lines: string[] = [];
  if (src.contact) {
    const c = src.contact;
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
    lines.push(
      `[Contact: ${name || "(no name)"} — ${c.phone_number || "(no phone)"}${c.vcard ? " — vCard present" : ""}]`,
    );
  }
  if (src.location && !src.venue) {
    const l = src.location;
    const live = l.live_period ? ` (live for ${l.live_period}s)` : "";
    lines.push(`[Location: lat ${l.latitude}, lon ${l.longitude}${live}]`);
  }
  if (src.venue) {
    const v = src.venue;
    const coord = v.location ? ` (lat ${v.location.latitude}, lon ${v.location.longitude})` : "";
    lines.push(`[Venue: "${v.title || "(untitled)"}" — ${v.address || "(no address)"}${coord}]`);
  }
  if (src.poll) {
    const p = src.poll;
    const opts = p.options.map((o) => `${o.text} (${o.voter_count || 0})`).join(", ");
    const closed = p.is_closed ? " — closed" : "";
    const anon = p.is_anonymous ? " (anonymous)" : "";
    lines.push(
      `[Poll${anon}: "${p.question || "(no question)"}" — ${opts || "(no options)"} — total ${p.total_voter_count || 0} votes${closed}]`,
    );
  }
  return lines.join("\n");
}

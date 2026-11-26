import type { Message } from "grammy/types";
import type { PreparedTelegramPluginCommand } from "./bot-native-command-plugins.js";

// Fork-local (kwaku): a plugin command captioned on one part of a Telegram album. Telegram sends each
// part as its own update, so the native command handler only sees the captioned part. It authorizes the
// command, marks the part here, and passes it on to the media-group buffer, which runs the command once
// with every part's media when the album flushes.

// Keyed by bot + chat + message id, not by object: the pipeline may hand a copy of the message along,
// and two bot accounts in one process see the same message ids in a shared group.
// An entry nobody takes (the part was dropped on the way) is evicted after MARK_TTL_MS.
const MARK_TTL_MS = 60_000;
const marked = new Map<string, { prepared: PreparedTelegramPluginCommand; at: number }>();

const keyOf = (botId: number | undefined, msg: Message) =>
  `${botId ?? ""}:${msg.chat.id}:${msg.message_id}`;

export function markAlbumPluginCommand(
  botId: number | undefined,
  msg: Message,
  prepared: PreparedTelegramPluginCommand,
): void {
  const now = Date.now();
  for (const [key, entry] of marked) {
    if (now - entry.at > MARK_TTL_MS) {
      marked.delete(key);
    }
  }
  marked.set(keyOf(botId, msg), { prepared, at: now });
}

export function isAlbumPluginCommand(botId: number | undefined, msg: Message): boolean {
  return marked.has(keyOf(botId, msg));
}

/** The prepared command on one of `msgs`, removed so it can only run once. */
export function takeAlbumPluginCommand(
  botId: number | undefined,
  msgs: readonly Message[],
): { msg: Message; prepared: PreparedTelegramPluginCommand } | undefined {
  for (const msg of msgs) {
    const entry = marked.get(keyOf(botId, msg));
    if (entry) {
      marked.delete(keyOf(botId, msg));
      return { msg, prepared: entry.prepared };
    }
  }
  return undefined;
}

/** Runs a prepared plugin command with the given album parts' media (just the command part when unset). */
export async function runAlbumPluginCommand(
  prepared: PreparedTelegramPluginCommand,
  albumMessages?: Message[],
): Promise<void> {
  const { runPreparedTelegramPluginCommand } = await import("./bot-native-command-plugins.js");
  // Album parts are chat messages, never channel posts: only a message reaches the plugin handler.
  await runPreparedTelegramPluginCommand(
    prepared,
    albumMessages as Parameters<typeof runPreparedTelegramPluginCommand>[1],
  );
}

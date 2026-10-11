import type { Api } from "grammy";
import { Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";

// Fork Patch 5 (patches/grammy@1.41.1.patch): bot commands in a photo/video caption
// must match, so a photo captioned "/claude describe this" reaches /claude.

const me = { id: 1, is_bot: true, first_name: "Bot", username: "my_bot" } as UserFromGetMe;

function ctxFor(message: Record<string, unknown>) {
  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 100, type: "private" },
      from: { id: 200, is_bot: false, first_name: "Bob" },
      ...message,
    },
  } as unknown as Update;
  return new Context(update, {} as Api, me);
}

const isClaude = Context.has.command("claude");

describe("grammy caption commands", () => {
  it("matches a command in a photo caption", () => {
    const ctx = ctxFor({
      photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
      caption: "/claude describe this",
      caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    expect(isClaude(ctx)).toBe(true);
  });

  it("matches a command in a video caption addressed to this bot", () => {
    const ctx = ctxFor({
      video: { file_id: "v", file_unique_id: "v", width: 1, height: 1, duration: 1 },
      caption: "/claude@my_bot what happens here",
      caption_entities: [{ type: "bot_command", offset: 0, length: 14 }],
    });
    expect(isClaude(ctx)).toBe(true);
  });

  it("still matches plain text commands", () => {
    const ctx = ctxFor({
      text: "/claude hi",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    expect(isClaude(ctx)).toBe(true);
  });

  it("ignores a caption that only mentions a command mid-sentence", () => {
    const ctx = ctxFor({
      photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
      caption: "try /claude later",
      caption_entities: [{ type: "bot_command", offset: 4, length: 7 }],
    });
    expect(isClaude(ctx)).toBe(false);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectPluginCommandInboundMedia,
  formatStructuredShares,
} from "./plugin-command-inbound-media.js";

const message = (fields: Partial<Message>): Message =>
  ({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, ...fields }) as Message;

describe("formatStructuredShares", () => {
  it("returns an empty string for plain messages", () => {
    expect(formatStructuredShares(message({ text: "hi" }))).toBe("");
    expect(formatStructuredShares(undefined)).toBe("");
  });

  it("formats a contact", () => {
    expect(
      formatStructuredShares(
        message({ contact: { phone_number: "+15550000", first_name: "Ada", last_name: "L" } }),
      ),
    ).toBe("[Contact: Ada L — +15550000]");
  });

  it("formats a venue once, not also as a bare location", () => {
    const out = formatStructuredShares(
      message({
        location: { latitude: 1, longitude: 2 },
        venue: { location: { latitude: 1, longitude: 2 }, title: "Cafe", address: "Main St" },
      }),
    );
    expect(out).toBe('[Venue: "Cafe" — Main St (lat 1, lon 2)]');
  });

  it("formats a live location", () => {
    expect(
      formatStructuredShares(message({ location: { latitude: 1, longitude: 2, live_period: 60 } })),
    ).toBe("[Location: lat 1, lon 2 (live for 60s)]");
  });
});

describe("collectPluginCommandInboundMedia", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "inbound-media-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fs.rm(home, { recursive: true, force: true });
  });

  const fakeBot = (getFile = vi.fn(async (id: string) => ({ file_path: `photos/${id}.jpg` }))) =>
    ({ token: "TEST_TOKEN", api: { getFile } }) as unknown as Bot;

  it("returns nothing extra for a text-only command", async () => {
    const out = await collectPluginCommandInboundMedia({
      bot: fakeBot(),
      msg: message({ text: "/claude hi" }),
    });
    expect(out).toEqual({ attachments: [], replyTo: null, structured: "" });
  });

  it("downloads the largest photo and tags replied-to media", async () => {
    const out = await collectPluginCommandInboundMedia({
      bot: fakeBot(),
      msg: message({
        caption: "/claude look",
        photo: [
          { file_id: "small", file_unique_id: "s", width: 1, height: 1 },
          { file_id: "large", file_unique_id: "l", width: 9, height: 9 },
        ],
        reply_to_message: message({
          message_id: 7,
          text: "earlier",
          from: { id: 2, is_bot: false, first_name: "Bo", username: "bo" },
          document: {
            file_id: "doc1",
            file_unique_id: "d",
            file_name: "a.pdf",
            mime_type: "application/pdf",
          },
        }) as Message["reply_to_message"],
      }),
    });

    expect(out.attachments.map((a) => [a.mime, a.fromReply])).toEqual([
      ["image/jpeg", false],
      ["application/pdf", true],
    ]);
    expect(out.attachments[1]?.originalName).toBe("a.pdf");
    expect(
      out.attachments[0]?.path.startsWith(path.join(home, ".openclaw", "media", "inbound")),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botTEST_TOKEN/photos/large.jpg",
    );
    expect(out.replyTo).toMatchObject({
      text: "earlier",
      fromUser: "bo",
      messageId: 7,
      hasMedia: true,
      fromBot: false,
    });
  });

  it("skips a failed download without dropping the others", async () => {
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram down"))
      .mockResolvedValue({ file_path: "voice/v.ogg" });
    const out = await collectPluginCommandInboundMedia({
      bot: fakeBot(getFile),
      msg: message({
        caption: "/claude",
        video: { file_id: "v1", file_unique_id: "v", width: 1, height: 1, duration: 1 },
        voice: { file_id: "voice1", file_unique_id: "vo", duration: 1 },
      }),
    });
    expect(out.attachments.map((a) => a.mime)).toEqual(["audio/ogg"]);
  });

  // Fork-local (kwaku): album support. `albumMessages` carries every part of a Telegram album
  // (the command part included); reply-to media still comes from `msg` only.
  it("collects every album part's media in message order, then the replied-to media", async () => {
    const part = (id: number, extra: Partial<Message> = {}) =>
      message({
        message_id: id,
        media_group_id: "G1",
        photo: [{ file_id: `album-part-${id}`, file_unique_id: `u${id}`, width: 9, height: 9 }],
        ...extra,
      });
    const commandPart = part(502, {
      caption: "/claude all",
      reply_to_message: message({
        message_id: 7,
        photo: [{ file_id: "replied-photo", file_unique_id: "r", width: 9, height: 9 }],
      }) as Message["reply_to_message"],
    });
    const getFile = vi.fn(async (id: string) => ({ file_path: `photos/${id}.jpg` }));

    const out = await collectPluginCommandInboundMedia({
      bot: fakeBot(getFile),
      msg: commandPart,
      albumMessages: [part(503), commandPart, part(501)],
    } as Parameters<typeof collectPluginCommandInboundMedia>[0]);

    expect(getFile.mock.calls.map(([id]) => id)).toEqual([
      "album-part-501",
      "album-part-502",
      "album-part-503",
      "replied-photo",
    ]);
    expect(
      out.attachments.map((a) => [a.path.match(/(part-\d+|d-photo)\./)?.[1], a.fromReply]),
    ).toEqual([
      ["part-501", false],
      ["part-502", false],
      ["part-503", false],
      ["d-photo", true],
    ]);
    expect(out.replyTo).toMatchObject({ messageId: 7, hasMedia: true });
  });

  it("treats an album list holding only the command message like a single message", async () => {
    const msg = message({
      caption: "/claude one",
      photo: [{ file_id: "solo", file_unique_id: "s", width: 9, height: 9 }],
    });
    const out = await collectPluginCommandInboundMedia({
      bot: fakeBot(),
      msg,
      albumMessages: [msg],
    } as Parameters<typeof collectPluginCommandInboundMedia>[0]);
    expect(out.attachments.map((a) => [a.mime, a.fromReply])).toEqual([["image/jpeg", false]]);
  });

  it("labels stickers by kind", async () => {
    const out = await collectPluginCommandInboundMedia({
      bot: fakeBot(),
      msg: message({
        text: "/claude",
        sticker: {
          file_id: "st",
          file_unique_id: "st",
          type: "regular",
          width: 1,
          height: 1,
          is_animated: true,
          is_video: false,
          set_name: "cats",
          emoji: "x",
        },
      }),
    });
    expect(out.attachments[0]).toMatchObject({
      mime: "application/x-tgsticker",
      originalName: "sticker-cats-x",
    });
  });
});

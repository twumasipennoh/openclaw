import type { Message } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedTelegramPluginCommand } from "./bot-native-command-plugins.js";
import {
  isAlbumPluginCommand,
  markAlbumPluginCommand,
  takeAlbumPluginCommand,
} from "./plugin-command-album.js";

// Fork-local (kwaku): the album plugin-command marks.

const msg = (chat: number, id: number) =>
  ({ chat: { id: chat }, message_id: id }) as unknown as Message;
const prepared = (name: string) =>
  ({ commandBody: `/${name}` }) as unknown as PreparedTelegramPluginCommand;

afterEach(() => {
  vi.useRealTimers();
});

describe("album plugin-command marks", () => {
  it("matches a copy of the marked message by chat and message id", () => {
    markAlbumPluginCommand(1, msg(10, 100), prepared("claude"));
    expect(isAlbumPluginCommand(1, { ...msg(10, 100) } as Message)).toBe(true);
    expect(
      takeAlbumPluginCommand(1, [msg(10, 99), { ...msg(10, 100) } as Message])?.prepared
        .commandBody,
    ).toBe("/claude");
  });

  it("is taken once only", () => {
    markAlbumPluginCommand(1, msg(10, 200), prepared("claude"));
    expect(takeAlbumPluginCommand(1, [msg(10, 200)])).toBeDefined();
    expect(takeAlbumPluginCommand(1, [msg(10, 200)])).toBeUndefined();
    expect(isAlbumPluginCommand(1, msg(10, 200))).toBe(false);
  });

  it("keeps two bots' marks on the same group message apart", () => {
    markAlbumPluginCommand(1, msg(-500, 300), prepared("one"));
    markAlbumPluginCommand(2, msg(-500, 300), prepared("two"));
    expect(takeAlbumPluginCommand(2, [msg(-500, 300)])?.prepared.commandBody).toBe("/two");
    expect(takeAlbumPluginCommand(1, [msg(-500, 300)])?.prepared.commandBody).toBe("/one");
  });

  it("does not match the same message id in another chat", () => {
    markAlbumPluginCommand(1, msg(10, 400), prepared("claude"));
    expect(takeAlbumPluginCommand(1, [msg(11, 400)])).toBeUndefined();
    expect(takeAlbumPluginCommand(1, [msg(10, 400)])).toBeDefined();
  });

  it("evicts a mark nobody took once it is older than a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
    markAlbumPluginCommand(1, msg(10, 500), prepared("stale"));
    vi.setSystemTime(new Date("2026-11-08T00:01:01Z"));
    markAlbumPluginCommand(1, msg(10, 501), prepared("fresh"));
    expect(isAlbumPluginCommand(1, msg(10, 500))).toBe(false);
    expect(isAlbumPluginCommand(1, msg(10, 501))).toBe(true);
    takeAlbumPluginCommand(1, [msg(10, 501)]);
  });

  it("keeps a mark younger than a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
    markAlbumPluginCommand(1, msg(10, 600), prepared("young"));
    vi.setSystemTime(new Date("2026-11-08T00:00:59Z"));
    markAlbumPluginCommand(1, msg(10, 601), prepared("other"));
    expect(isAlbumPluginCommand(1, msg(10, 600))).toBe(true);
    takeAlbumPluginCommand(1, [msg(10, 600), msg(10, 601)]);
    takeAlbumPluginCommand(1, [msg(10, 601)]);
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginCommandMocks, resetPluginCommandMocks } from "./test-support/plugin-command.js";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
import {
  createNativeCommandTestParams,
  createPrivateCommandContext,
  resetNativeCommandMenuMocks,
} from "./bot-native-commands.menu-test-support.js";

// Fork Patch 2 (👀 ack reaction on plugin command dispatch) and Patch 11 (retry the
// plugin command match while a plugin reload is re-registering commands).

type Handler = (ctx: unknown) => Promise<void>;

function registerPlugCommand(cfg: OpenClawConfig = {}) {
  const commandHandlers = new Map<string, Handler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const setMessageReaction = vi.fn().mockResolvedValue(true);
  pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
    { name: "plug", description: "Plugin command" },
  ] as never);
  pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "done" } as never);

  registerTelegramNativeCommands({
    ...createNativeCommandTestParams(cfg, {
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
          setMessageReaction,
        },
        command: vi.fn((name: string, cb: Handler) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    }),
  });

  const handler = commandHandlers.get("plug");
  expect(handler).toBeTruthy();
  return { handler: handler as Handler, sendMessage, setMessageReaction };
}

const plugMatch = { command: { key: "plug", requireAuth: false }, args: undefined } as never;

describe("telegram plugin commands (fork patches)", () => {
  beforeAll(async () => {
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
    // First import pulls every bundled channel plugin through jiti (~10 min cold).
  }, 900_000);

  beforeEach(() => {
    resetNativeCommandMenuMocks();
    resetPluginCommandMocks();
  });

  it("reacts with 👀 on the command message before running the plugin", async () => {
    pluginCommandMocks.matchPluginCommand.mockReturnValue(plugMatch);
    const { handler, setMessageReaction } = registerPlugCommand();

    await handler(createPrivateCommandContext({ chatId: 100, messageId: 42 }));

    expect(setMessageReaction).toHaveBeenCalledWith(100, 42, [{ type: "emoji", emoji: "👀" }]);
    expect(pluginCommandMocks.executePluginCommand).toHaveBeenCalled();
  });

  it("uses the configured ack reaction", async () => {
    pluginCommandMocks.matchPluginCommand.mockReturnValue(plugMatch);
    const { handler, setMessageReaction } = registerPlugCommand({
      messages: { ackReaction: "👍" },
    } as OpenClawConfig);

    await handler(createPrivateCommandContext({ chatId: 100, messageId: 42 }));

    expect(setMessageReaction).toHaveBeenCalledWith(100, 42, [{ type: "emoji", emoji: "👍" }]);
  });

  it("still runs the command when the reaction call fails", async () => {
    pluginCommandMocks.matchPluginCommand.mockReturnValue(plugMatch);
    const { handler, setMessageReaction } = registerPlugCommand();
    setMessageReaction.mockRejectedValue(new Error("REACTION_INVALID"));

    await handler(createPrivateCommandContext({ chatId: 100 }));

    expect(pluginCommandMocks.executePluginCommand).toHaveBeenCalled();
  });

  it("waits for a reloading plugin to re-register before answering", async () => {
    pluginCommandMocks.matchPluginCommand
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(plugMatch);
    const { handler, sendMessage } = registerPlugCommand();

    await handler(createPrivateCommandContext({ chatId: 100 }));

    expect(pluginCommandMocks.matchPluginCommand).toHaveBeenCalledTimes(3);
    expect(pluginCommandMocks.executePluginCommand).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(100, "Command not found.");
  });

  it("answers 'Command not found.' once the retries run out", async () => {
    pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
    const { handler, sendMessage } = registerPlugCommand();

    await handler(createPrivateCommandContext({ chatId: 100 }));

    expect(pluginCommandMocks.matchPluginCommand).toHaveBeenCalledTimes(5);
    expect(pluginCommandMocks.executePluginCommand).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(100, "Command not found.");
  });
});

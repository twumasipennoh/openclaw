// Fork-local (kwaku): a plugin command (/claude) captioned on a Telegram album must run once
// with every album part's media, not just the captioned part. Each album part is its own
// update, so these tests drive all parts through the real grammY bot and update tracker.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import {
  apiCalls,
  chat,
  createBot,
  from,
  groupChat,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { getTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";

type SeenAttachment = { path: string; mime: string; fromReply: boolean };
type PluginInvocation = { args: string; attachments: SeenAttachment[] };

const realFetch = globalThis.fetch;
// MEDIA_GROUP_TIMEOUT_MS in bot-updates.ts; createBot exposes no testTimings override.
const MEDIA_GROUP_FLUSH_MS = 500;
const pluginHandler = vi.fn<(ctx: { args?: string; attachments?: SeenAttachment[] }) => unknown>();
const invocations: PluginInvocation[] = [];
const NOT_AUTHORIZED = "You are not authorized to use this command.";

function registerClaude(options: { requireAuth?: boolean; acceptsArgs?: boolean } = {}) {
  registerPluginCommand("album-test", {
    name: "claude",
    description: "album test",
    acceptsArgs: options.acceptsArgs ?? true,
    requireAuth: options.requireAuth ?? false,
    handler: async (ctx: { args?: string; attachments?: SeenAttachment[] }) => {
      invocations.push({ args: String(ctx.args ?? ""), attachments: ctx.attachments ?? [] });
      return await pluginHandler(ctx);
    },
  } as never);
}

// file_id suffixes survive into the saved attachment name (`<ts>-<last 8 chars><ext>`).
const fileId = (id: number) => `album-part-${id}`;

function albumPart(
  id: number,
  c: object,
  options: { caption?: string; group?: string; extra?: object } = {},
): Message {
  const { caption, group = "G1", extra = {} } = options;
  return {
    message_id: id,
    date: 1736380800,
    chat: c,
    from,
    ...(group ? { media_group_id: group } : {}),
    photo: [{ file_id: fileId(id), file_unique_id: `u-${id}`, width: 10, height: 10 }],
    ...(caption
      ? {
          caption,
          ...(caption.startsWith("/")
            ? {
                caption_entities: [
                  { type: "bot_command", offset: 0, length: caption.split(" ")[0]!.length },
                ],
              }
            : {}),
        }
      : {}),
    ...extra,
  } as unknown as Message;
}

function album(c: object, captionOn: number, caption: string, extra: object = {}) {
  return [501, 502, 503].map((id, index) =>
    albumPart(id, c, { caption: index === captionOn ? caption : undefined, extra }),
  );
}

const dmConfig = (): OpenClawConfig => ({
  commands: { native: true, text: true },
  messages: { inbound: { debounceMs: 0 } },
  channels: {
    telegram: { dmPolicy: "open", allowFrom: ["*"], streaming: { mode: "off" } } as never,
  },
});

const groupExtra = { message_thread_id: 99, is_topic_message: true };

const groupConfig = (telegram: object): OpenClawConfig => ({
  commands: { native: true, text: true },
  messages: { inbound: { debounceMs: 0 } },
  channels: { telegram: { groupPolicy: "open", streaming: { mode: "off" }, ...telegram } as never },
});

function agentTurns() {
  return harness.replySpy.mock.calls.map(([ctx]) => {
    const m = ctx as Record<string, unknown>;
    // The native pipeline hands the resolver materialized refs on `media`, not `MediaPaths`.
    const mediaPaths = Array.isArray(m.media)
      ? (m.media as Array<{ path?: unknown }>).filter((ref) => typeof ref.path === "string").length
      : Array.isArray(m.MediaPaths)
        ? m.MediaPaths.length
        : 0;
    return { body: String(m.RawBody ?? m.Body ?? ""), mediaPaths };
  });
}

function notAuthorizedReplies() {
  return apiCalls.mock.calls.filter(
    ([method, payload]) =>
      method === "sendMessage" && (payload as { text?: unknown }).text === NOT_AUTHORIZED,
  );
}

function sentTexts(match: (text: string) => boolean) {
  return apiCalls.mock.calls.filter(
    ([method, payload]) =>
      method === "sendMessage" && match(String((payload as { text?: unknown }).text ?? "")),
  );
}

const partIdOf = (attachment: SeenAttachment) => attachment.path.match(/part-(\d+)\./)?.[1];

// Each part's pre-buffer work (dedupe claim, auth) hits the state database and can exceed the
// real 500 ms album window on a cold worker, so the parts would flush as separate one-photo
// albums whose dispatches then block each other. Hold the album timer until every part is
// buffered, then flush it once, as the coalescing e2e test does.
async function deliverAll(bot: Awaited<ReturnType<typeof createBot>>, messages: Message[]) {
  const albumTimers = holdTelegramMediaTimeouts(MEDIA_GROUP_FLUSH_MS);
  try {
    await Promise.all(
      messages.map((message, index) =>
        bot.handleUpdate({ update_id: 9000 + index, message } as never),
      ),
    );
    const flush = resolveFlushTimerForDelay(albumTimers, MEDIA_GROUP_FLUSH_MS);
    albumTimers.mockRestore();
    (flush as (() => void) | undefined)?.();
  } finally {
    albumTimers.mockRestore();
  }
}

// A cold agent turn (worker + agent database preparation) takes ~20-30 s on this harness, so the
// agent-path waits are long; a short wait fails first and its cleanup then closes the databases
// under the still-running dispatch ("admission is closed").
const AGENT_TURN_WAIT_MS = 60_000;

async function waitForAgentReplyDelivered() {
  await vi.waitFor(() => expect(harness.replySpy).toHaveBeenCalled(), {
    timeout: AGENT_TURN_WAIT_MS,
  });
  // Let the final reply land before cleanup closes the delivery claim store.
  await vi.waitFor(
    () => expect(apiCalls.mock.calls.some(([method]) => method === "sendMessage")).toBe(true),
    { timeout: AGENT_TURN_WAIT_MS },
  );
}

// Lets the 500 ms album flush and any (unwanted) agent dispatch happen before asserting absence.
async function settle(ms = 1500) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await harness.settleUpdates();
}

beforeEach(() => {
  invocations.length = 0;
  pluginHandler.mockReset().mockResolvedValue({ text: "ok" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.telegram.org/file/")) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    }
    return realFetch(input as never, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin command captioned on a Telegram album (fork-local)", () => {
  // Runs first: an agent turn torn down mid-flight by an earlier test's cleanup (the bug path
  // and the not-authorized guard both start sibling agent turns) can stall later agent turns
  // in the same worker.
  it("an album with an ordinary caption reaches the agent once with all media and never the plugin", async () => {
    registerClaude();
    const bot = await createBot(true, true, dmConfig());
    await deliverAll(bot, album(chat, 0, "look at these"));
    await waitForAgentReplyDelivered();
    await settle();

    expect(invocations).toHaveLength(0);
    expect(agentTurns()).toEqual([
      { body: expect.stringContaining("look at these"), mediaPaths: 3 },
    ]);
  }, 150000);

  it("album captioned with a command that isn't a plugin command gets one `Command not found.` and no plugin run", async () => {
    // acceptsArgs: false makes prepareDispatch return { kind: "non-plugin" } for "/claude describe all".
    registerClaude({ acceptsArgs: false });
    const bot = await createBot(true, true, dmConfig());
    await deliverAll(bot, album(chat, 0, "/claude describe all"));
    await settle(3000);

    expect(invocations).toHaveLength(0);
    expect(sentTexts((text) => text === "Command not found.")).toHaveLength(1);
    // The command part is consumed by the native handler, so the command text never reaches the
    // agent. The uncaptioned siblings take the unchanged album path; their agent turn isn't awaited
    // here because this harness can't run a second agent turn in one worker after the first test's.
    expect(agentTurns().every((turn) => !turn.body.includes("/claude"))).toBe(true);
  }, 150000);

  it("DM: caption on part 1 runs the plugin once with all three parts and no agent turn", async () => {
    registerClaude();
    const bot = await createBot(true, true, dmConfig());
    await deliverAll(bot, album(chat, 0, "/claude describe all"));
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toBe("describe all");
    expect(invocations[0]?.attachments.map(partIdOf)).toEqual(["501", "502", "503"]);
    expect(invocations[0]?.attachments.every((a) => a.fromReply === false)).toBe(true);
    expect(harness.replySpy).not.toHaveBeenCalled();
  }, 20000);

  it("DM: caption on part 2 runs the plugin once with all three parts", async () => {
    registerClaude();
    const bot = await createBot(true, true, dmConfig());
    await deliverAll(bot, album(chat, 1, "/claude describe all"));
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.attachments.map(partIdOf)).toEqual(["501", "502", "503"]);
    expect(harness.replySpy).not.toHaveBeenCalled();
  }, 20000);

  it("group with requireMention and no @mention: authorized sender's album runs the plugin once with all parts", async () => {
    registerClaude();
    const bot = await createBot(
      true,
      true,
      groupConfig({
        allowFrom: ["*"],
        groups: { [String(groupChat.id)]: { requireMention: true } },
      }),
    );
    await deliverAll(bot, album(groupChat, 0, "/claude describe all", groupExtra));
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.attachments.map(partIdOf)).toEqual(["501", "502", "503"]);
    expect(harness.replySpy).not.toHaveBeenCalled();
  }, 20000);

  it("sender allowed by the message gate but not command-authorized gets one not-authorized reply and no plugin run", async () => {
    registerClaude({ requireAuth: true });
    const bot = await createBot(
      true,
      true,
      groupConfig({
        allowFrom: ["11111"],
        groups: { [String(groupChat.id)]: { requireMention: false } },
      }),
    );
    await deliverAll(bot, album(groupChat, 0, "/claude describe all", groupExtra));
    await settle(2000);

    expect(invocations).toHaveLength(0);
    expect(notAuthorizedReplies()).toHaveLength(1);
    // Siblings keep today's path (the denied part is consumed, never re-routed): the command
    // text never reaches the agent and nothing is dispatched twice.
    expect(agentTurns().filter((turn) => turn.body.includes("/claude"))).toEqual([]);
    expect(agentTurns().length).toBeLessThanOrEqual(1);
  }, 20000);

  it("a plugin that throws during the album run releases claims, dispatches no agent turn, and is not retried", async () => {
    registerClaude();
    pluginHandler.mockRejectedValue(new Error("plugin exploded"));
    const bot = await createBot(true, true, dmConfig());
    const runtime = getTelegramRuntime();
    let queue: ReturnType<typeof createChannelIngressQueueForTests> | undefined;
    setTelegramRuntime({
      ...runtime,
      state: {
        ...runtime.state,
        openChannelIngressQueue: (options) =>
          (queue = createChannelIngressQueueForTests({ ...options, channelId: "telegram" })),
      },
    });
    try {
      const monitor = createTelegramTransportIngressMonitor({
        bot,
        accountId: "default",
        botInfo: bot.botInfo,
      });
      try {
        monitor.start();
        const messages = album(chat, 0, "/claude describe all");
        for (const [index, message] of messages.entries()) {
          await monitor.admit({ update_id: 9100 + index, message });
        }
        await monitor.waitForIdle();
        await monitor.waitForDeferredClaims();
        await settle();
        await monitor.waitForIdle();
        await monitor.waitForDeferredClaims();
      } finally {
        await monitor.stop();
      }
    } finally {
      setTelegramRuntime(runtime);
    }

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.attachments.map(partIdOf)).toEqual(["501", "502", "503"]);
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(queue).toBeDefined();
    expect(await queue!.listClaims()).toEqual([]);
    expect(await queue!.listPending({ limit: "all" })).toEqual([]);
  }, 180000);

  it("`/claude@otherbot` on an album runs neither the plugin nor an agent turn", async () => {
    registerClaude();
    const bot = await createBot(true, true, dmConfig());
    await deliverAll(bot, album(chat, 0, "/claude@otherbot describe all"));
    await settle(3000);

    expect(invocations).toHaveLength(0);
    // was expecting an ordinary agent turn, but a command addressed to another bot is dropped by design
    // (bot-message-context.body.ts:188), album or not
    expect(agentTurns()).toHaveLength(0);
  }, 150000);

  it("regression: a single photo captioned `/claude x` runs the plugin once with one attachment", async () => {
    registerClaude();
    const bot = await createBot(true, true, dmConfig());
    await deliverAll(bot, [albumPart(601, chat, { caption: "/claude x", group: "" })]);
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle(700);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toBe("x");
    expect(invocations[0]?.attachments.map((a) => [partIdOf(a), a.fromReply])).toEqual([
      ["601", false],
    ]);
    expect(harness.replySpy).not.toHaveBeenCalled();
  }, 20000);

  it("album command part replying to a photo includes the replied photo with fromReply true", async () => {
    registerClaude();
    const bot = await createBot(true, true, dmConfig());
    const replied = albumPart(400, chat, { group: "" });
    const messages = album(chat, 0, "/claude compare");
    messages[0] = { ...messages[0], reply_to_message: replied } as Message;
    await deliverAll(bot, messages);
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.attachments.map((a) => [partIdOf(a), a.fromReply])).toEqual([
      ["501", false],
      ["502", false],
      ["503", false],
      ["400", true],
    ]);
    expect(harness.replySpy).not.toHaveBeenCalled();
  }, 20000);

  it("message gate stricter than the command gate: an unpaired DM runs the plugin once with only the command part", async () => {
    // requireAuth: false lets the native command gate pass an unpaired DM sender; the message
    // gate (dmPolicy "pairing", sender not paired) rejects every part.
    registerClaude({ requireAuth: false });
    const bot = await createBot(true, true, {
      commands: { native: true, text: true },
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: { dmPolicy: "pairing", allowFrom: [], streaming: { mode: "off" } } as never,
      },
    });
    await deliverAll(bot, album(chat, 0, "/claude describe all"));
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle(2000);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toBe("describe all");
    // Single-part fallback: the rejected siblings never reach the album buffer.
    expect(invocations[0]?.attachments.map(partIdOf)).toEqual(["501"]);
    expect(harness.replySpy).not.toHaveBeenCalled();
    // The command part is gated silently, so no pairing reply is sent for it. The siblings keep
    // the normal challenge path; one pending pairing request per sender means one reply for both.
    expect(sentTexts((text) => text.includes("Pairing code:"))).toHaveLength(1);
  }, 20000);

  it("message gate stricter than the command gate: a plugin that throws on the single-part run is logged, not retried, and reaches no agent", async () => {
    registerClaude({ requireAuth: false });
    pluginHandler.mockRejectedValue(new Error("plugin exploded"));
    const bot = await createBot(true, true, {
      commands: { native: true, text: true },
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: { dmPolicy: "pairing", allowFrom: [], streaming: { mode: "off" } } as never,
      },
    });
    await deliverAll(bot, album(chat, 0, "/claude describe all"));
    await vi.waitFor(() => expect(invocations.length).toBeGreaterThan(0), { timeout: 5000 });
    await settle(2000);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.attachments.map(partIdOf)).toEqual(["501"]);
    expect(harness.replySpy).not.toHaveBeenCalled();
  }, 20000);
});

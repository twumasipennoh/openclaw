import { Agent } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

// Fork Patch 1 (patches/@mariozechner__pi-agent-core@0.65.0.patch): a stream event that
// lands after finishRun() must be dropped, not throw "Agent listener invoked outside
// active run" (seen when a cancelled run's provider stream flushes late).

type LateEventAgent = { processEvents(event: unknown): Promise<void> };

describe("pi-agent-core late stream events", () => {
  it("drops an event that arrives with no active run", async () => {
    const agent = new Agent();
    const listener = vi.fn();
    agent.subscribe(listener);

    await expect(
      (agent as unknown as LateEventAgent).processEvents({ type: "agent_end", messages: [] }),
    ).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});

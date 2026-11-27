import fs from "node:fs";
import { expect, it } from "vitest";
import { withOpenClawTestState as withState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource as seedSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

// A home reached through a symlink (e.g. /home/old -> /home/new) gives the agent database
// two spellings: the configured path and its realpath. Receipt keys hash the configured
// one, so every receipt read must use it too.
it("finds a deferred plugin's import receipt when the state dir is reached through a symlink", () =>
  withState({ label: "deferred-plugin-symlinked-state" }, async (state) => {
    const { cfg } = await seedSource(state, "default");
    const link = `${state.root}-link`;
    fs.symlinkSync(state.root, link, "dir");
    try {
      const env = Object.fromEntries(
        Object.entries(state.env).map(([key, value]) => [
          key,
          typeof value === "string" && value.startsWith(state.root)
            ? link + value.slice(state.root.length)
            : value,
        ]),
      );
      const run = () => runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      const imported = await run();
      expect(imported.totals.importedEntries).toBe(2);
      expect(imported.targets.flatMap((target) => target.issues)).toContainEqual(
        expect.objectContaining({ code: "plugin_migration_source_retained" }),
      );
      await expect(run()).resolves.toMatchObject({ totals: { importedEntries: 0 } });
    } finally {
      fs.rmSync(link);
    }
  }));

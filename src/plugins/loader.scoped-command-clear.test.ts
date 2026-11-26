import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clearPluginCommands } from "./command-registry-state.js";
import { getPluginCommandSpecs } from "./command-specs.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

// Fork Patch 3: a scoped (onlyPluginIds) activating reload must not wipe other plugins'
// commands, or /claude answers "Command not found." until the next restart.

afterEach(() => {
  clearPluginCommands();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

const commandPluginBody = (id: string, name: string) => `module.exports = {
  id: "${id}",
  register(api) {
    api.registerCommand({
      name: "${name}",
      description: "${name} command",
      handler: async () => ({ text: "${name}" }),
    });
  },
};`;

describe("scoped plugin reload keeps other plugins' commands", () => {
  it("re-registers only the reloaded plugin's commands", () => {
    useNoBundledPlugins();
    const dir = makePluginLoaderTempDir();
    const keeper = writePlugin({
      id: "keeper-plugin",
      dir: `${dir}/keeper`,
      body: commandPluginBody("keeper-plugin", "keep"),
    });
    const reloader = writePlugin({
      id: "reloader-plugin",
      dir: `${dir}/reloader`,
      body: commandPluginBody("reloader-plugin", "reload"),
    });
    const config = {
      plugins: {
        load: { paths: [keeper.file, reloader.file] },
        allow: ["keeper-plugin", "reloader-plugin"],
      },
    };

    loadOpenClawPlugins({ cache: false, workspaceDir: dir, config });
    expect(
      getPluginCommandSpecs()
        .map((spec) => spec.name)
        .toSorted(),
    ).toEqual(["keep", "reload"]);

    loadOpenClawPlugins({
      cache: false,
      workspaceDir: dir,
      config,
      onlyPluginIds: ["reloader-plugin"],
    });

    expect(
      getPluginCommandSpecs()
        .map((spec) => spec.name)
        .toSorted(),
    ).toEqual(["keep", "reload"]);
  });
});

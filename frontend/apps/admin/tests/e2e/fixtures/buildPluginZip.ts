import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

// package.json sets "type": "module", so Playwright loads this file as
// native ESM — __dirname isn't available there (see playwright.config.ts
// for the same workaround).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXAMPLE_GAME_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../../../../../server/tests/fixtures/plugins/games/example-game"
);

export async function buildExampleGamePluginZip(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `example-game-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(EXAMPLE_GAME_PLUGIN_DIR, false);
    void archive.finalize();
  });
  return outPath;
}

const BALANCED_SCHEDULER_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../../../../../server/plugins/schedulers/balanced"
);

/** Only manifest.json and plugin.py: the folder can also hold a __pycache__ that doesn't belong in a plugin zip. */
export async function buildBalancedSchedulerPluginZip(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `balanced-scheduler-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(path.join(BALANCED_SCHEDULER_PLUGIN_DIR, "manifest.json"), { name: "manifest.json" });
    archive.file(path.join(BALANCED_SCHEDULER_PLUGIN_DIR, "plugin.py"), { name: "plugin.py" });
    void archive.finalize();
  });
  return outPath;
}

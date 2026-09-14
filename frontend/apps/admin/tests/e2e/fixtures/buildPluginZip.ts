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

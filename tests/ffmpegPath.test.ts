import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { resolveDevelopmentFfmpegPath, resolveFfmpegPath } =
  require("../src/main/runtime/assets/ffmpeg-path.cjs") as {
    resolveDevelopmentFfmpegPath: () => string | null;
    resolveFfmpegPath: (options: { toolsDir: string }) => string;
  };

describe("FFmpeg path resolution", () => {
  it("uses the installed development FFmpeg when tools has no bundled copy", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-ffmpeg-path-"));
    const toolsDir = join(temporaryRoot, "tools");
    mkdirSync(join(toolsDir, "ffmpeg"), { recursive: true });

    try {
      const developmentFfmpegPath = resolveDevelopmentFfmpegPath();
      const ffmpegPath = resolveFfmpegPath({ toolsDir });

      expect(developmentFfmpegPath).not.toBeNull();
      expect(ffmpegPath).toBe(developmentFfmpegPath);
      expect(existsSync(ffmpegPath)).toBe(true);
      expect(statSync(ffmpegPath).isFile()).toBe(true);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

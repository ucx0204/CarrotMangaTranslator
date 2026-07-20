import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const { resolveFfmpegPath } =
  require("../src/main/runtime/assets/ffmpeg-path.cjs") as {
    resolveFfmpegPath: (options: { toolsDir: string }) => string;
  };

describe("FFmpeg path resolution", () => {
  it("uses the installed development FFmpeg when tools has no bundled copy", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-ffmpeg-path-"));
    const toolsDir = join(temporaryRoot, "tools");
    mkdirSync(join(toolsDir, "ffmpeg"), { recursive: true });

    try {
      const ffmpegPath = resolveFfmpegPath({ toolsDir });
      const result = spawnSync(ffmpegPath, ["-version"], {
        encoding: "utf8",
        shell: false,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ffmpeg version");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

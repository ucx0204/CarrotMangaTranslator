const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const [, , runtimePath, ffmpegPath] = process.argv;
if (!runtimePath || !ffmpegPath) {
  throw new Error("Expected runtime and ffmpeg paths.");
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-packaged-image-"));
const ppmPath = join(temporaryRoot, "source.ppm");
const webpPath = join(temporaryRoot, "source.webp");
const pngPath = join(temporaryRoot, "normalized.png");

async function main() {
  try {
    const pixels = Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255,
    ]);
    writeFileSync(
      ppmPath,
      Buffer.concat([Buffer.from("P6\n2 2\n255\n"), pixels]),
    );
    const encode = spawnSync(
      ffmpegPath,
      ["-v", "error", "-y", "-i", ppmPath, webpPath],
      { encoding: "utf8", windowsHide: true },
    );
    if (encode.error) throw encode.error;
    if (encode.status !== 0) {
      throw new Error(`Could not create WebP smoke fixture: ${encode.stderr}`);
    }

    const runtime = require(runtimePath);
    await runtime.convertImageToPngFileWithFfmpeg(webpPath, pngPath, {
      // FFmpeg's WebP decoder validates its 64-pixel-aligned internal frame,
      // not only the 2x2 display dimensions used by this fixture.
      maxPixels: 1024,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 30_000,
    });
    const output = readFileSync(pngPath);
    if (!output.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error("Packaged image runtime did not produce a PNG.");
    }
    console.log("packaged-webp-runtime-ok");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

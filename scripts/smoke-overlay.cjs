const { app } = require("electron");
const path = require("node:path");
const { runSmokeOverlay } = require("./smoke-overlay/runner.cjs");
const {
  normalizeSmokeProvider,
  readIntEnv,
} = require("./smoke-overlay/utils.cjs");

const root = path.join(__dirname, "..");
const defaultMangaRoot =
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas";

runSmokeOverlay({
  root,
  mangaRoot: process.env.MANGA_SMOKE_MANGA_ROOT || defaultMangaRoot,
  sampleCount: readIntEnv("MANGA_SMOKE_COUNT", 30),
  sampleOffset: readIntEnv("MANGA_SMOKE_SAMPLE_OFFSET", 0),
  targetImagePath: process.env.MANGA_SMOKE_IMAGE_PATH || "",
  targetImageList: process.env.MANGA_SMOKE_IMAGE_LIST || "",
  targetImageListFile: process.env.MANGA_SMOKE_IMAGE_LIST_FILE || "",
  smokeProvider: normalizeSmokeProvider(process.env.MANGA_SMOKE_PROVIDER),
  reuseOcrDir: process.env.MANGA_SMOKE_REUSE_OCR_DIR || "",
  maxCaptureLongSide: readIntEnv("MANGA_SMOKE_MAX_LONG_SIDE", 1400),
  pageTimeoutMs: readIntEnv("MANGA_SMOKE_PAGE_TIMEOUT_MS", 120000),
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

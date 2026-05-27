const { app, BrowserWindow } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image || !args.json || !args.output) {
    throw new Error("Usage: electron scripts/render-ocr-bbox.cjs --image <path> --json <path> --output <path>");
  }

  app.setPath("userData", path.join(ROOT, ".tmp", "ocr-bbox-render-user-data"));
  app.commandLine.appendSwitch("disable-gpu");
  app.on("window-all-closed", (event) => event.preventDefault());
  await app.whenReady();

  const payload = JSON.parse(await readFile(args.json, "utf8"));
  const width = Number(payload.width);
  const height = Number(payload.height);
  const imageDataUrl = await readImageDataUrl(args.image);
  const maxLongSide = Number(args.maxLongSide || process.env.MANGA_OCR_RENDER_MAX_LONG_SIDE || 1400);
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  const win = new BrowserWindow({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    show: false,
    webPreferences: { offscreen: true }
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(payload, scale, imageDataUrl))}`);
    await waitForReady(win);
    const image = await win.webContents.capturePage();
    await writeFile(args.output, image.toPNG());
    console.log(`[ocr-render] wrote ${args.output}`);
  } finally {
    win.destroy();
    app.quit();
  }
}

function buildHtml(payload, scale, imageDataUrl) {
  const width = Math.round(Number(payload.width) * scale);
  const height = Math.round(Number(payload.height) * scale);
  const rows = (payload.items || []).map((item) => {
    const left = Number(item.x1) * scale;
    const top = Number(item.y1) * scale;
    const boxWidth = (Number(item.x2) - Number(item.x1)) * scale;
    const boxHeight = (Number(item.y2) - Number(item.y1)) * scale;
    const label = `${item.id || ""} ${item.label || "text"}`.trim();
    return `<div class="bbox" style="left:${left}px;top:${top}px;width:${boxWidth}px;height:${boxHeight}px;"><span>${escapeHtml(label)}</span></div>`;
  });

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
.stage { position: relative; width: ${width}px; height: ${height}px; }
.page { position: absolute; inset: 0; width: 100%; height: 100%; }
.bbox {
  position: absolute;
  box-sizing: border-box;
  border: 3px solid #facc15;
  background: rgba(250, 204, 21, 0.13);
}
.bbox span {
  position: absolute;
  left: 0;
  top: -22px;
  padding: 2px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.78);
  color: #facc15;
  font: 700 13px "Malgun Gothic", sans-serif;
  white-space: nowrap;
}
</style></head>
<body>
<div class="stage">
  <img class="page" src="${escapeHtml(imageDataUrl)}" />
  ${rows.join("\n")}
</div>
<script>window.addEventListener("load", () => setTimeout(() => document.body.dataset.ready = "1", 120));</script>
</body></html>`;
}

async function readImageDataUrl(filePath) {
  const buffer = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
}

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/jpeg";
}

function waitForReady(win) {
  return win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      if (document.body.dataset.ready === "1") resolve(true);
      const timer = setInterval(() => {
        if (document.body.dataset.ready === "1") {
          clearInterval(timer);
          resolve(true);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        resolve(true);
      }, 3000);
    })
  `);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    result[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return result;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const rendererDir = join(process.cwd(), "out", "renderer");
const forbiddenPatterns = [
  /\belectron\b/,
  /\bipcRenderer\b/,
  /\bcontextBridge\b/,
  /\bpreload bridge\b/i,
  /(?:^|[\\/])preload(?:[\\/]|\.|$)/,
  /src[\\/]preload/i,
];

function listFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

if (!existsSync(rendererDir)) {
  console.error("Renderer build output is missing. Run npm run build first.");
  process.exit(1);
}

const offenders = [];
for (const filePath of listFiles(rendererDir)) {
  if (!/\.(?:html|js|css)$/i.test(filePath)) {
    continue;
  }
  const source = readFileSync(filePath, "utf8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(source)) {
      offenders.push({ filePath, pattern: String(pattern) });
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "Renderer bundle contains forbidden Electron/preload boundary references:",
  );
  for (const offender of offenders) {
    console.error(`- ${offender.filePath} matched ${offender.pattern}`);
  }
  process.exit(1);
}

console.log("renderer bundle boundary guard passed");

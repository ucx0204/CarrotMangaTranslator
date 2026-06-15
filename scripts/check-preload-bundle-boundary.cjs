const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const preloadPath = join(process.cwd(), "out", "preload", "index.js");

if (!existsSync(preloadPath)) {
  console.error(
    "Preload bundle is missing. Run npm run compile:electron first.",
  );
  process.exit(1);
}

const source = readFileSync(preloadPath, "utf8");
const requirePattern = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
const offenders = [];
let match = requirePattern.exec(source);

while (match) {
  const specifier = match[2];
  if (specifier !== "electron") {
    offenders.push(specifier);
  }
  match = requirePattern.exec(source);
}

if (offenders.length > 0) {
  console.error("Preload bundle contains forbidden runtime require calls:");
  for (const specifier of offenders) {
    console.error(`- require(${JSON.stringify(specifier)})`);
  }
  process.exit(1);
}

console.log("preload bundle boundary guard passed");

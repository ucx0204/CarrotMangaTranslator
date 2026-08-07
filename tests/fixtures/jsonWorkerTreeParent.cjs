/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS process fixture */
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const grandchildScript = process.argv[2];
const pidFile = process.argv[3];
const heartbeatFile = process.argv[4];
const ignoreShutdown = process.argv[5] === "ignore-shutdown";
let buffer = "";
let grandchild = null;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;

    const request = JSON.parse(line);
    if (request.type === "hang") {
      grandchild ??= spawn(
        process.execPath,
        [grandchildScript, heartbeatFile],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      writeFileSync(pidFile, String(grandchild.pid), "utf8");
      continue;
    }

    if (request.type === "shutdown" && !ignoreShutdown) {
      process.exit(0);
    }
  }
});

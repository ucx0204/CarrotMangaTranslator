/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS process fixture */
const { writeFileSync } = require("node:fs");

const heartbeatFile = process.argv[2];

function writeHeartbeat() {
  writeFileSync(heartbeatFile, String(Date.now()), "utf8");
}

writeHeartbeat();
setInterval(writeHeartbeat, 50);

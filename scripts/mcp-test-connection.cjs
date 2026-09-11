const { randomBytes } = require("node:crypto");
const { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const tokenPath = join(root, ".tmp", "mcp-local-token");

/** @param {unknown} value @returns {string} */
function validateToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new Error("Invalid MCP token. Use the launcher to create a random local token.");
  }
  return value;
}

/** Read only a small regular file. Never follow a token-file symlink. */
function readLocalToken() {
  const info = lstatSync(tokenPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) {
    throw new Error("MCP token must be a small regular file, not a link.");
  }
  const fd = openSync(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return validateToken(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

/** @param {NodeJS.ProcessEnv} [env] */
function prepareLocalToken(env = process.env) {
  if (env.CARROT_MCP_TOKEN) return validateToken(env.CARROT_MCP_TOKEN);
  mkdirSync(join(root, ".tmp"), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  try {
    writeFileSync(tokenPath, token, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    return readLocalToken();
  }
}

/** @param {NodeJS.ProcessEnv} [env] */
function readTestConnection(env = process.env) {
  const token = env.CARROT_MCP_TOKEN
    ? validateToken(env.CARROT_MCP_TOKEN)
    : readLocalToken();
  const port = env.CARROT_MCP_PORT ?? "38475";
  const url = new URL(env.CARROT_MCP_URL ?? `http://127.0.0.1:${port}/mcp`);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("Use a loopback HTTP or HTTPS MCP URL ending in /mcp, without credentials or query parameters.");
  }
  return { url: url.href, token };
}

module.exports = { prepareLocalToken, readTestConnection, tokenPath };

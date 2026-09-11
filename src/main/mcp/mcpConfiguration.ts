export type McpConfiguration = {
  port: number;
  token: string;
  publicOrigin?: string;
  allowImages?: boolean;
  oauthPassword?: string;
};

/** Opt-in only. Credentials are supplied locally and are never generated into logs. */
export function readMcpConfiguration(
  env: NodeJS.ProcessEnv,
): McpConfiguration | null {
  if (env.CARROT_MCP_ENABLED !== "1") return null;
  const token = env.CARROT_MCP_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
    throw new Error("CARROT_MCP_TOKEN must be a 43-128 character base64url token.");
  const portText = env.CARROT_MCP_PORT ?? "38475";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
    throw new Error("CARROT_MCP_PORT must be an integer from 1 to 65535.");
  const publicOrigin = env.CARROT_MCP_PUBLIC_ORIGIN
    ? readPublicOrigin(env.CARROT_MCP_PUBLIC_ORIGIN)
    : undefined;
  const images = env.CARROT_MCP_ALLOW_IMAGES ?? "0";
  if (images !== "0" && images !== "1")
    throw new Error("CARROT_MCP_ALLOW_IMAGES must be 0 or 1.");
  const oauthPassword = readOAuthPassword(env, publicOrigin, token);
  return { port, token, publicOrigin, allowImages: images === "1", oauthPassword };
}

function readOAuthPassword(env: NodeJS.ProcessEnv, origin: string | undefined, token: string): string | undefined {
  const enabled = env.CARROT_MCP_OAUTH_ENABLED ?? "0";
  if (enabled === "0") return undefined;
  if (enabled !== "1") throw new Error("CARROT_MCP_OAUTH_ENABLED must be 0 or 1.");
  const password = env.CARROT_MCP_OAUTH_PASSWORD ?? "";
  if (!origin || !/^[A-Za-z0-9_-]{43,128}$/.test(password) || password === token)
    throw new Error("Web OAuth requires an exact HTTPS origin and a separate 43-128 character connection password.");
  return password;
}

function readPublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.includes("*")
  ) throw new Error("CARROT_MCP_PUBLIC_ORIGIN must be one exact HTTPS origin.");
  return url.origin;
}

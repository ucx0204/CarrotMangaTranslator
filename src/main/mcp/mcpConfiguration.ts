export type McpConfiguration = {
  port: number;
  token: string;
  publicOrigin?: string;
};

/** Opt-in only. Credentials are supplied locally and are never generated into logs. */
export function readMcpConfiguration(
  env: NodeJS.ProcessEnv,
): McpConfiguration | null {
  if (env.CARROT_MCP_ENABLED !== "1") return null;
  const token = env.CARROT_MCP_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
    throw new Error(
      "CARROT_MCP_TOKEN must be a 43-128 character base64url token.",
    );
  const portText = env.CARROT_MCP_PORT ?? "38475";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
    throw new Error("CARROT_MCP_PORT must be an integer from 1 to 65535.");
  const publicOrigin = env.CARROT_MCP_PUBLIC_ORIGIN
    ? readPublicOrigin(env.CARROT_MCP_PUBLIC_ORIGIN)
    : undefined;
  return { port, token, publicOrigin };
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
  )
    throw new Error("CARROT_MCP_PUBLIC_ORIGIN must be one exact HTTPS origin.");
  return url.origin;
}

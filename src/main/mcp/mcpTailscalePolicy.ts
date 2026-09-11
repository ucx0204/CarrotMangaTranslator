type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tailscale returned an invalid status document.");
  return value as JsonObject;
}

/** The node identity, not a parsed log line or a forwarded HTTP header, owns the URL. */
export function readTailscaleOrigin(value: unknown): string {
  const status = object(value);
  if (status.BackendState !== "Running")
    throw new Error("Sign in and connect in the Tailscale application first.");
  const self = object(status.Self);
  if (self.Online === false)
    throw new Error("This Tailscale device is offline.");
  const hostname =
    typeof self.DNSName === "string"
      ? self.DNSName.toLowerCase().replace(/\.$/, "")
      : "";
  if (
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/.test(hostname)
  )
    throw new Error("Enable MagicDNS and HTTPS for this Tailscale device.");
  return `https://${hostname}`;
}

/** Funnel exposes an entire HTTPS listener. Never publish another app's Serve routes. */
export function assertTailscaleListenerFree(value: unknown, port = 443): void {
  const queue = [object(value ?? {})];
  let examined = 0;
  while (queue.length) {
    const config = queue.pop();
    if (!config) break;
    if (++examined > 256)
      throw new Error(
        "Tailscale sharing configuration is too large to inspect safely.",
      );
    const tcp = config.TCP === undefined ? {} : object(config.TCP);
    const web = config.Web === undefined ? {} : object(config.Web);
    if (
      Object.hasOwn(tcp, String(port)) ||
      Object.keys(web).some((key) => key.endsWith(`:${port}`))
    )
      throw new Error(
        "Tailscale HTTPS port 443 is already used. Carrot will not replace or expose another application's route.",
      );
    for (const group of [config.Foreground, config.Services]) {
      if (group === undefined || group === null) continue;
      for (const child of Object.values(object(group)))
        queue.push(object(child));
    }
  }
}

/** This is a local setup action, never a remote tool or an automatic browser redirect. */
export function readTailscaleSetupUrl(text: string): string | undefined {
  const match = text.match(
    /https:\/\/login\.tailscale\.com\/[A-Za-z0-9_/?=&.%+-]+/,
  );
  if (!match) return undefined;
  const url = new URL(match[0]);
  return url.origin === "https://login.tailscale.com" ? url.href : undefined;
}

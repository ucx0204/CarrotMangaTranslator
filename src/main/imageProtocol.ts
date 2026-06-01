import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { assertLibraryImagePath } from "./library";
import { logError } from "./logger";

const IMAGE_PROTOCOL = "mgt-image";
const MAX_IMAGE_TOKENS = 500;

const imageTokens = new Map<string, string>();

export function registerImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true
      }
    }
  ]);
}

export function registerImageProtocolHandler(): void {
  protocol.handle(IMAGE_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url);
      const token = url.hostname || url.pathname.replace(/^\/+/, "");
      const imagePath = imageTokens.get(token);
      if (!imagePath) {
        return new Response("Image token not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(imagePath).toString());
    } catch (error) {
      logError("Failed to serve image protocol request", { url: request.url, error });
      return new Response("Image protocol error", { status: 500 });
    }
  });
}

export function createLibraryImageUrl(imagePath: string): string {
  const resolvedImagePath = assertLibraryImagePath(imagePath);
  const token = randomUUID();
  imageTokens.set(token, resolvedImagePath);
  trimImageTokens();
  return `${IMAGE_PROTOCOL}://${token}`;
}

function trimImageTokens(): void {
  while (imageTokens.size > MAX_IMAGE_TOKENS) {
    const oldestToken = imageTokens.keys().next().value;
    if (!oldestToken) {
      return;
    }
    imageTokens.delete(oldestToken);
  }
}

import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { resolveCustomFontFilePath } from "./customFonts";
import { assertLibraryImagePath, getLibraryRoot } from "./library";
import {
  createLibraryImageUrlCodec,
  createNodeLibraryImageUrlFiles,
} from "./imageUrlCodec";
import { logError } from "./logger";

const IMAGE_PROTOCOL = "mgt-image";
const FONT_PROTOCOL = "mgt-font";
const imageUrlCodec = createLibraryImageUrlCodec({
  secret: randomBytes(32),
  files: createNodeLibraryImageUrlFiles(getLibraryRoot()),
});

export function registerImageProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
    {
      scheme: FONT_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function registerImageProtocolHandler(): void {
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    try {
      const imagePath = imageUrlCodec.resolveUrl(request.url);
      if (!imagePath) {
        return new Response("Image not found", { status: 404 });
      }
      return await net.fetch(pathToFileURL(imagePath).toString());
    } catch (error) {
      logError("Failed to serve image protocol request", {
        url: request.url,
        error,
      });
      return new Response("Image protocol error", { status: 500 });
    }
  });

  protocol.handle(FONT_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname || url.pathname.replace(/^\/+/, "");
      const fontPath = resolveCustomFontFilePath(id);
      if (!fontPath) {
        return new Response("Font not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(fontPath).toString());
    } catch (error) {
      logError("Failed to serve font protocol request", {
        url: request.url,
        error,
      });
      return new Response("Font protocol error", { status: 500 });
    }
  });
}

export function createLibraryImageUrl(imagePath: string): string {
  const resolvedImagePath = assertLibraryImagePath(imagePath);
  return imageUrlCodec.createUrl(resolvedImagePath);
}

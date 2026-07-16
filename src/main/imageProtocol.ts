import { protocol } from "electron";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { resolveCustomFontFilePath } from "./customFonts";
import {
  createProtocolFileResponse,
  isProtocolFileUnavailableError,
} from "./protocolFileResponse";
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
        stream: true,
        supportFetchAPI: true,
      },
    },
    {
      scheme: FONT_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function registerImageProtocolHandler(): void {
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    try {
      const image = imageUrlCodec.resolveRequest(request.url);
      if (!image) {
        return protocolErrorResponse("Image not found", 404);
      }
      return await createProtocolFileResponse(image.imagePath, {
        contentType: image.contentType,
        expectedVersion: {
          size: image.size,
          mtimeNs: image.mtimeNs,
        },
      });
    } catch (error) {
      if (isProtocolFileUnavailableError(error)) {
        return protocolErrorResponse("Image not found", 404);
      }
      logError("Failed to serve image protocol request", {
        url: request.url,
        error,
      });
      return protocolErrorResponse("Image protocol error", 500);
    }
  });

  protocol.handle(FONT_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname || url.pathname.replace(/^\/+/, "");
      const fontPath = resolveCustomFontFilePath(id);
      if (!fontPath) {
        return protocolErrorResponse("Font not found", 404);
      }
      const contentType = resolveFontContentType(fontPath);
      if (!contentType) {
        return protocolErrorResponse("Font not found", 404);
      }
      return await createProtocolFileResponse(fontPath, { contentType });
    } catch (error) {
      if (isProtocolFileUnavailableError(error)) {
        return protocolErrorResponse("Font not found", 404);
      }
      logError("Failed to serve font protocol request", {
        url: request.url,
        error,
      });
      return protocolErrorResponse("Font protocol error", 500);
    }
  });
}

export function createLibraryImageUrl(imagePath: string): string {
  const resolvedImagePath = assertLibraryImagePath(imagePath);
  return imageUrlCodec.createUrl(resolvedImagePath);
}

function resolveFontContentType(fontPath: string): string | null {
  switch (extname(fontPath).toLowerCase()) {
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    default:
      return null;
  }
}

function protocolErrorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

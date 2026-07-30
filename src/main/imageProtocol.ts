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
  type LibraryImageUrlCodec,
} from "./imageUrlCodec";
import { logError } from "./logger";

const IMAGE_PROTOCOL = "mgt-image";
const FONT_PROTOCOL = "mgt-font";

type ProtocolRequest = {
  url: string;
};

type ProtocolBoundary = {
  registerSchemesAsPrivileged: (schemes: Electron.CustomScheme[]) => void;
  handle: (
    scheme: string,
    handler: (request: ProtocolRequest) => Promise<Response>,
  ) => void;
};

type ProtocolFileOptions = Parameters<typeof createProtocolFileResponse>[1];

export type ImageProtocolDependencies = {
  protocol: ProtocolBoundary;
  imageUrls: LibraryImageUrlCodec;
  resolveLibraryImagePath: (path: string) => string;
  resolveFontFilePath: (id: string) => string | null;
  serveFile: (path: string, options: ProtocolFileOptions) => Promise<Response>;
  isUnavailableError: (error: unknown) => boolean;
  reportError: (message: string, context: unknown) => void;
};

export type ImageProtocolController = {
  registerScheme: () => void;
  registerHandler: () => void;
  createLibraryImageUrl: (imagePath: string) => string;
};

let productionController: ImageProtocolController | undefined;

export function createImageProtocolController(
  dependencies: ImageProtocolDependencies,
): ImageProtocolController {
  return {
    registerScheme: () => registerScheme(dependencies.protocol),
    registerHandler: () => registerHandler(dependencies),
    createLibraryImageUrl: (imagePath) =>
      dependencies.imageUrls.createUrl(
        dependencies.resolveLibraryImagePath(imagePath),
      ),
  };
}

export function registerImageProtocolScheme(): void {
  registerScheme(createElectronProtocolBoundary());
}

function registerScheme(protocolBoundary: ProtocolBoundary): void {
  protocolBoundary.registerSchemesAsPrivileged([
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
        corsEnabled: true,
      },
    },
  ]);
}

export function registerImageProtocolHandler(): void {
  getProductionController().registerHandler();
}

function registerHandler(dependencies: ImageProtocolDependencies): void {
  dependencies.protocol.handle(IMAGE_PROTOCOL, async (request) => {
    try {
      const image = dependencies.imageUrls.resolveRequest(request.url);
      if (!image) {
        return protocolErrorResponse("Image not found", 404);
      }
      return await dependencies.serveFile(image.imagePath, {
        contentType: image.contentType,
        expectedVersion: {
          size: image.size,
          mtimeNs: image.mtimeNs,
        },
      });
    } catch (error) {
      if (dependencies.isUnavailableError(error)) {
        return protocolErrorResponse("Image not found", 404);
      }
      dependencies.reportError("Failed to serve image protocol request", {
        url: request.url,
        error,
      });
      return protocolErrorResponse("Image protocol error", 500);
    }
  });

  dependencies.protocol.handle(FONT_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname || url.pathname.replace(/^\/+/, "");
      const fontPath = dependencies.resolveFontFilePath(id);
      if (!fontPath) {
        return protocolErrorResponse("Font not found", 404);
      }
      const contentType = resolveFontContentType(fontPath);
      if (!contentType) {
        return protocolErrorResponse("Font not found", 404);
      }
      return await dependencies.serveFile(fontPath, { contentType });
    } catch (error) {
      if (dependencies.isUnavailableError(error)) {
        return protocolErrorResponse("Font not found", 404);
      }
      dependencies.reportError("Failed to serve font protocol request", {
        url: request.url,
        error,
      });
      return protocolErrorResponse("Font protocol error", 500);
    }
  });
}

export function createLibraryImageUrl(imagePath: string): string {
  return getProductionController().createLibraryImageUrl(imagePath);
}

function getProductionController(): ImageProtocolController {
  productionController ??= createImageProtocolController({
    protocol: createElectronProtocolBoundary(),
    imageUrls: createLibraryImageUrlCodec({
      secret: randomBytes(32),
      files: createNodeLibraryImageUrlFiles(getLibraryRoot()),
    }),
    resolveLibraryImagePath: assertLibraryImagePath,
    resolveFontFilePath: resolveCustomFontFilePath,
    serveFile: createProtocolFileResponse,
    isUnavailableError: isProtocolFileUnavailableError,
    reportError: logError,
  });
  return productionController;
}

function createElectronProtocolBoundary(): ProtocolBoundary {
  return {
    registerSchemesAsPrivileged: (schemes) =>
      protocol.registerSchemesAsPrivileged(schemes),
    handle: (scheme, handler) =>
      protocol.handle(scheme, (request) => handler(request)),
  };
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

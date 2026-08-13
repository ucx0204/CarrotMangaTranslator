import { protocol } from "electron";
import { extname } from "node:path";
import { createProtocolFileResponse } from "./protocolFileResponse";
import type { WebImportSessionManager } from "./webImportSessionManager";

const WEB_IMPORT_PREVIEW_PROTOCOL = "mgt-import-preview";

type WebImportPreviewFileServer = typeof createProtocolFileResponse;

export function registerWebImportPreviewProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WEB_IMPORT_PREVIEW_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function registerWebImportPreviewProtocolHandler(
  manager: WebImportSessionManager,
): void {
  protocol.handle(
    WEB_IMPORT_PREVIEW_PROTOCOL,
    createWebImportPreviewRequestHandler(manager),
  );
}

export function createWebImportPreviewRequestHandler(
  manager: Pick<WebImportSessionManager, "resolvePreviewFile">,
  serveFile: WebImportPreviewFileServer = createProtocolFileResponse,
): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const sessionId = url.hostname;
      const candidateId = url.pathname.replace(/^\/+/, "");
      const filePath = manager.resolvePreviewFile(sessionId, candidateId);
      if (!filePath) {
        return unavailableResponse();
      }
      return await serveFile(filePath, {
        cacheControl: "no-store",
        contentType: contentTypeFor(filePath),
      });
    } catch (_error) {
      return unavailableResponse();
    }
  };
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function unavailableResponse(): Response {
  return new Response("Image not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

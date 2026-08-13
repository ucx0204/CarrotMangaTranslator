import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWebImportPreviewRequestHandler } from "../src/main/webImportProtocol";

describe("web import preview protocol", () => {
  it("resolves an opaque session and candidate URL without exposing a file path", async () => {
    const resolvePreviewFile = vi.fn(() => "C:\\staging\\candidate.jpg");
    const serveFile = vi.fn(async () => new Response("image"));
    const handler = createWebImportPreviewRequestHandler(
      { resolvePreviewFile },
      serveFile,
    );

    const response = await handler({
      url: "mgt-import-preview://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
    });

    expect(response.status).toBe(200);
    expect(resolvePreviewFile).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(serveFile).toHaveBeenCalledWith("C:\\staging\\candidate.jpg", {
      cacheControl: "no-store",
      contentType: "image/jpeg",
    });
  });

  it("allows the preview scheme in the renderer image CSP", async () => {
    const html = await readFile(
      join(process.cwd(), "src", "renderer", "index.html"),
      "utf8",
    );
    expect(html).toMatch(/img-src[^;]*mgt-import-preview:/);
  });
});

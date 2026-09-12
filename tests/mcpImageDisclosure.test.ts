import { beforeEach, expect, it, vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import {
  cropMcpPage,
  renderMcpPagePng,
} from "../src/main/mcp/mcpPageImageAdapter";
import { renderMcpPagePreview } from "../src/main/mcp/mcpPreviewImage";

const ports = vi.hoisted(() => ({
  enabled: false,
  prepare: vi.fn(async (path: string) => path),
  review: vi.fn(async () => {}),
  render: vi.fn(async () => Buffer.from("rendered")),
  close: vi.fn(),
  cancel: vi.fn(),
  encoded: vi.fn(() => Buffer.from("preview")),
}));
vi.mock("electron", () => ({ nativeImage: {} }));
vi.mock("../src/main/imageRedactionContext", () => ({
  prepareExternalImageFile: ports.prepare,
  requireImageRedactionReview: ports.review,
}));
vi.mock("../src/main/imageRedactionStore", () => ({
  readImageRedactionState: async () => ({ enabled: ports.enabled, pages: {} }),
}));
vi.mock("../src/main/inpainting/imageIO", () => ({
  loadPageImage: async () => {
    const image = {
      getSize: () => ({ width: 1000, height: 1600 }),
      toPNG: ports.encoded,
      crop: () => image,
      resize: () => image,
    };
    return image;
  },
}));
vi.mock("../src/main/pageExport", () => ({
  createPageExportRenderSession: async () => ({
    renderPage: ports.render,
    cancel: ports.cancel,
    close: ports.close,
  }),
}));
vi.mock("../src/main/appPaths", () => ({
  getAppPaths: () => ({ dataRoot: "/synthetic" }),
}));
vi.mock("../src/main/pageExportRasterSafety", () => ({
  probePageExportSourceImage: async () => ({ width: 1000, height: 1600 }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  ports.enabled = false;
  ports.prepare.mockImplementation(async (path) => path);
  ports.review.mockImplementation(async () => {
    if (ports.enabled) throw new Error("Redaction review now required");
  });
  ports.render.mockImplementation(async () => Buffer.from("rendered"));
  ports.encoded.mockImplementation(() => Buffer.from("preview"));
});
it.each(["crop", "source"])(
  "rechecks review before disclosing a %s image encoded after the user enables redaction",
  async (kind) => {
    ports.encoded.mockImplementationOnce(() => {
      ports.enabled = true;
      return Buffer.from("must-not-return");
    });
    const page = editingChapter().pages[0];
    await expect(
      kind === "crop"
        ? cropMcpPage(page, { x: 0, y: 0, w: 20, h: 20 })
        : renderMcpPagePreview(page),
    ).rejects.toThrow("Redaction review now required");
    expect(ports.review).toHaveBeenCalledOnce();
  },
);
it("does not return a derived PNG when protection changes while the renderer works", async () => {
  ports.render.mockImplementationOnce(async () => {
    ports.enabled = true;
    return Buffer.from("must-not-return");
  });
  await expect(
    renderMcpPagePng(editingChapter().pages[0]),
  ).rejects.toMatchObject({
    code: "access_denied",
  });
  expect(ports.close).toHaveBeenCalledOnce();
});
it("keeps the original-resolution renderer path and closes the render session on success", async () => {
  const page = editingChapter().pages[0];
  await expect(renderMcpPagePng(page)).resolves.toEqual(
    Buffer.from("rendered"),
  );
  expect(ports.render).toHaveBeenCalledWith(
    { ...page, imagePath: page.inpaintedImagePath },
    { format: "png", resolutionMode: "original" },
  );
  expect(ports.close).toHaveBeenCalledOnce();
});

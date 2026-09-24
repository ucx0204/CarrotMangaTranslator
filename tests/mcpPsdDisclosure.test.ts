import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import {
  psdCaptureFixture,
  psdOptions,
  readPsdPixels,
} from "./mcpPsdExport.fixture";

async function fixture() {
  const env = await mcpAppEnvironment();
  const page = { ...editingChapter().pages[0], width: 8, height: 8 };
  const capture = psdCaptureFixture(page);
  page.imagePath = join(env.root, "psd-original.png");
  page.inpaintedImagePath = join(env.root, "psd-cleaned.png");
  await writeFile(page.imagePath, capture.original);
  await writeFile(page.inpaintedImagePath, capture.cleaned);
  const adapter = await import("../src/main/mcp/mcpPageImageAdapter");
  const openRenderer = vi.fn(async () => capture.session);
  const protect = () =>
    writeFileSync(
      join(env.root, "image-redactions.json"),
      JSON.stringify({ enabled: true, pages: {} }),
    );
  const render = (signal?: AbortSignal) =>
    adapter.renderMcpPageImage(page, signal, psdOptions, 1000, openRenderer);
  return { ...env, page, capture, adapter, openRenderer, protect, render };
}

it("exports the actual original layer without inventing an inpainted layer when none exists", async () => {
  const f = await fixture();
  try {
    delete f.page.inpaintedImagePath;
    const before = structuredClone(f.page);
    const parsed = readPsdPixels(await f.render());
    expect(parsed.children?.[0].name).toContain("Original");
    expect(
      parsed.children?.some((layer) => layer.name?.includes("Inpaint")),
    ).toBe(false);
    expect(f.page).toEqual(before);
    expect(f.capture.session.close).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("checks original dimensions separately even when the cleaned background remains valid", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.page.imagePath,
      PNG.sync.write(new PNG({ width: 4, height: 4 })),
    );
    await expect(f.render()).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.openRenderer).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not return any layered PSD when protection becomes required during native capture", async () => {
  const f = await fixture();
  try {
    f.capture.session.renderPage.mockImplementationOnce(async () => {
      f.protect();
      return f.capture.composite;
    });
    await expect(f.render()).rejects.toMatchObject({ code: "access_denied" });
    expect(f.capture.session.close).toHaveBeenCalledOnce();
    await expect(f.render()).rejects.toMatchObject({ code: "access_denied" });
    expect(f.openRenderer).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("requires transparent layer capture rather than substituting a flattened PSD", async () => {
  const f = await fixture();
  try {
    const open = vi.fn(async () => ({
      renderPage: f.capture.session.renderPage,
      close: f.capture.session.close,
    }));
    await expect(
      f.adapter.renderMcpPageImage(f.page, undefined, psdOptions, 1000, open),
    ).rejects.toThrow("PSD text-layer renderer is unavailable");
    expect(f.capture.session.close).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("cancels and closes the PSD renderer without returning partially assembled output", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    f.capture.session.renderPage.mockImplementationOnce(async () => {
      controller.abort();
      return f.capture.composite;
    });
    await expect(f.render(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.capture.session.cancel).toHaveBeenCalledOnce();
    expect(f.capture.session.close).toHaveBeenCalledOnce();
    expect(f.capture.session.renderTransparentPage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["png", "psd"] as const)(
  "rejects late %s output even when renderer cancellation settles with bytes",
  async (format) => {
    const f = await fixture();
    const controller = new AbortController();
    let release = () => {};
    try {
      let entered = () => {};
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.openRenderer.mockImplementationOnce(async () => {
        vi.useFakeTimers();
        return f.capture.session;
      });
      f.capture.session.renderPage.mockImplementationOnce(async () => {
        entered();
        await paused;
        return f.capture.composite;
      });
      const pending = f.adapter.renderMcpPageImage(
        f.page,
        controller.signal,
        format === "psd" ? psdOptions : { format, omitText: false },
        1000,
        f.openRenderer,
      );
      const assertion = expect(pending).rejects.toThrow(
        "MCP page output timed out",
      );
      await ready;
      await vi.advanceTimersByTimeAsync(1001);
      expect(f.capture.session.cancel).toHaveBeenCalledOnce();
      controller.abort(new Error("Later user cancellation"));
      release();
      await assertion;
      expect(f.capture.session.cancel).toHaveBeenCalledOnce();
      expect(f.capture.session.renderPage).toHaveBeenCalledOnce();
      expect(f.capture.session.renderTransparentPage).not.toHaveBeenCalled();
      expect(f.capture.session.close).toHaveBeenCalledOnce();
    } finally {
      release();
      vi.useRealTimers();
      await f.close();
    }
  },
);

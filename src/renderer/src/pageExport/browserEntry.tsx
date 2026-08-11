import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { PageArtwork } from "../components/PageArtwork";
import {
  loadBlockFonts,
  type BlockFontLoadReport,
} from "../lib/blockFontLoading";
import { createBlockFontCatalog } from "../lib/fonts";
import { parsePageExportData } from "./documentData";
import { assertDecodedPageExportImageSize } from "./rasterValidation";
import type { PageExportRasterSize } from "../../../shared/pageExportLimits";
import "./styles.css";

function bootPageExport(): void {
  void startPageExport().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown page export error";
    console.error("Page export render failed.", error);
    document.body.dataset.error = message;
  });
}

if (document.readyState === "loading") {
  window.addEventListener("load", bootPageExport, { once: true });
} else {
  bootPageExport();
}

async function startPageExport(): Promise<void> {
  const stage = document.getElementById("stage");
  if (!stage) throw new Error("Page export stage is missing.");
  const data = parsePageExportData(document.getElementById("page-export-data"));
  const showImage = !data.transparentBackground;
  if (!showImage) {
    // The production renderer stylesheet gives :root the dark app surface.
    // Mark both root and body so the PSD-only text capture stays genuinely
    // transparent instead of baking a full-canvas #101114 layer.
    document.documentElement.dataset.transparentBackground = "1";
    document.body.dataset.transparentBackground = "1";
  }
  const catalog = createBlockFontCatalog(
    data.fontLibrary.customFonts,
    data.fontLibrary.preferences,
  );
  const [imageSize, fontReport] = await Promise.all([
    decodeExportImage(data.imageSrc, data.outputSize),
    loadBlockFonts(document, data.page.blocks, catalog),
  ]);
  assertFontsLoaded(fontReport);
  const root = createRoot(stage);
  flushSync(() => {
    root.render(
      <PageArtwork
        fontCatalog={catalog}
        imageSrc={data.imageSrc}
        page={data.page}
        showImage={showImage}
        visualSize={imageSize}
      />,
    );
  });
  await waitForRenderedImage(stage, showImage);
  await waitForTwoAnimationFrames();
  document.body.dataset.outputWidth = String(data.outputSize.width);
  document.body.dataset.outputHeight = String(data.outputSize.height);
  document.body.dataset.ready = "1";
}

async function decodeExportImage(
  src: string,
  expected: PageExportRasterSize,
): Promise<PageExportRasterSize> {
  const image = new Image();
  image.decoding = "sync";
  image.src = src;
  await image.decode();
  const actual = { width: image.naturalWidth, height: image.naturalHeight };
  assertDecodedPageExportImageSize(actual, expected);
  return actual;
}

async function waitForRenderedImage(
  stage: HTMLElement,
  showImage: boolean,
): Promise<void> {
  if (!showImage) return;
  const image = stage.querySelector<HTMLImageElement>(".page-image");
  if (!image) throw new Error("Page export image was not rendered.");
  await image.decode();
}

function assertFontsLoaded(report: BlockFontLoadReport): void {
  if (report.failures.length > 0) {
    throw new Error(
      `Page export font loading failed: ${report.failures
        .map(
          (failure) => `${failure.css} (${formatFontLoadError(failure.error)})`,
        )
        .join("; ")}`,
    );
  }
  if (report.missingFamilies.length > 0) {
    throw new Error(
      `Page export fonts are missing: ${report.missingFamilies.join(", ")}`,
    );
  }
}

function formatFontLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForTwoAnimationFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { z } from "zod";
import { PageExportDocumentDataSchema } from "../src/shared/pageExportContracts";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { ImageStage } from "../src/renderer/src/components/ImageStage";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { useStageSize } from "../src/renderer/src/hooks/useStageSize";
import { useWorkspaceZoomStyle } from "../src/renderer/src/hooks/useWorkspaceZoomStyle";
import {
  loadBlockFonts,
  type BlockFontLoadReport,
} from "../src/renderer/src/lib/blockFontLoading";
import { createBlockFontCatalog } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import { waitForWarpDisplacementMaps } from "../src/renderer/src/lib/warpDisplacementMap";

const PixelParityPayloadSchema = z
  .object({
    document: PageExportDocumentDataSchema,
    panelSize: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

void startPanelArtwork().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown panel render error";
  console.error("Panel pixel-parity render failed.", error);
  document.body.dataset.error = message;
});

async function startPanelArtwork(): Promise<void> {
  const stage = document.getElementById("root");
  const dataElement = document.getElementById("pixel-parity-data");
  if (!stage || !dataElement) {
    throw new Error("Panel pixel-parity document is incomplete.");
  }
  const payload = PixelParityPayloadSchema.parse(
    JSON.parse(dataElement.textContent ?? ""),
  );
  const catalog = createBlockFontCatalog(
    payload.document.fontLibrary.customFonts,
    payload.document.fontLibrary.preferences,
  );
  const fontReport = await loadBlockFonts(
    document,
    payload.document.page.blocks,
    catalog,
  );
  assertFontsLoaded(fontReport);
  const imageSize = await decodeImage(payload.document.imageSrc);
  await initializeAppI18n("ko");
  const page = {
    ...payload.document.page,
    analysisStatus: "completed" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    dataUrl: "",
    imagePath: "pixel-parity.png",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const root = createRoot(stage);
  flushSync(() => {
    root.render(
      <I18nextProvider i18n={appI18n}>
        <FontsContext.Provider
          value={{
            baseOptions: [],
            busy: false,
            catalog,
            options: [],
            registerFont: async () => undefined,
            removeFont: async () => undefined,
            savePreferences: async () => undefined,
          }}
        >
          <PanelArtwork imageSrc={payload.document.imageSrc} page={page} />
        </FontsContext.Provider>
      </I18nextProvider>,
    );
  });
  await waitForRenderedImage(stage, imageSize);
  await waitForWarpDisplacementMaps(stage);
  await waitForPanelSize(stage, payload.panelSize);
  await waitForFrames(4);
  document.body.dataset.ready = "1";
}

function PanelArtwork({
  imageSrc,
  page,
}: {
  imageSrc: string;
  page: Parameters<typeof ImageStage>[0]["page"];
}): React.JSX.Element {
  const imageRef = React.useRef<HTMLImageElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const workspaceRef = React.useRef<HTMLDivElement>(null);
  const previewStore = React.useMemo(
    () => createWorkspaceInteractionPreviewStore(),
    [],
  );
  const stageSize = useStageSize(
    imageRef,
    { width: page.width, height: page.height },
    imageSrc,
  );
  const zoomStyle = useWorkspaceZoomStyle({
    containerRef: workspaceRef,
    fitMode: "actual",
    imageRef,
    imageRevision: imageSrc,
    page,
    zoom: 1,
  });
  return (
    <div
      ref={workspaceRef}
      className={`workspace ${zoomStyle.className}`.trim()}
      data-pixel-parity-workspace=""
      style={zoomStyle.style}
    >
      <ImageStage
        blockPointerDisabled
        imageDataUrl={imageSrc}
        imageRef={imageRef}
        interactionPreviewStore={previewStore}
        onBlockPointerDown={() => undefined}
        onStagePointerDown={() => undefined}
        onStagePointerLeave={() => undefined}
        onStagePointerMove={() => undefined}
        onStagePointerUp={() => undefined}
        page={page}
        regionSelectionActive={false}
        regionSelectionRect={null}
        selectedBlockId={null}
        selectedBlockIds={[]}
        showBlockChrome={false}
        showTextBlocks
        stageRef={stageRef}
        stageSize={stageSize}
        stageTool="select"
        textLayoutStageSize={{ width: page.width, height: page.height }}
      />
    </div>
  );
}

async function decodeImage(src: string): Promise<{
  width: number;
  height: number;
}> {
  const image = new Image();
  image.decoding = "sync";
  image.src = src;
  await image.decode();
  if (image.naturalWidth < 1 || image.naturalHeight < 1) {
    throw new Error("Panel pixel-parity image has invalid dimensions.");
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

async function waitForRenderedImage(
  stage: HTMLElement,
  expected: { width: number; height: number },
): Promise<void> {
  const image = stage.querySelector<HTMLImageElement>(".page-image");
  if (!image) throw new Error("Panel image was not rendered.");
  await image.decode();
  if (
    image.naturalWidth !== expected.width ||
    image.naturalHeight !== expected.height
  ) {
    throw new Error("Panel image dimensions changed during rendering.");
  }
}

async function waitForPanelSize(
  stage: HTMLElement,
  expected: { width: number; height: number },
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= 10_000) {
    const artwork = stage.querySelector<HTMLElement>(".image-stage");
    const rect = artwork?.getBoundingClientRect();
    if (rect?.width === expected.width && rect.height === expected.height) {
      return;
    }
    await waitForFrames(1);
  }
  throw new Error(
    `Panel artwork did not reach ${expected.width}x${expected.height}.`,
  );
}

function assertFontsLoaded(report: BlockFontLoadReport): void {
  if (report.failures.length > 0) {
    throw new AggregateError(
      report.failures.map((failure) => failure.error),
      "Panel pixel-parity font loading failed.",
    );
  }
  if (report.missingFamilies.length > 0) {
    throw new Error(
      `Panel pixel-parity fonts are missing: ${report.missingFamilies.join(", ")}`,
    );
  }
}

function waitForFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (remaining: number): void => {
      if (remaining < 1) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(remaining - 1));
    };
    tick(count);
  });
}

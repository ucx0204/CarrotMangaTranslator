import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import type {
  CodexPageReading,
  CodexPageRegion,
} from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  codexSourceContextRect,
  createCodexEraseMask,
  refineCodexSourceRegion,
  CodexEraseMaskError,
} from "../../shared/codexTypesettingMask";
import { normalizedRegionToPixelRect } from "../../shared/region";
import type { TypesettingImage } from "../application/codexTypesettingContracts";
import {
  assertExactMembership,
  erasurePlansSchema,
  erasureCommitSchema,
  typesettingOutputSchema,
} from "../application/codexTypesettingValidation";
import type { CodexAppServerPreviewTool } from "../codexAppServerProtocol";
import { fillPlainMask } from "./codexTypesettingRaster";

type Plans = ReturnType<typeof erasurePlansSchema.parse>;
type PreviewArtifact = {
  revision: number;
  sha256: string;
  plans: Plans;
  unresolvedRegionIds: string[];
};
type Context = {
  page: MangaPage;
  reading: CodexPageReading;
  images: TypesettingImage[];
  stage: string;
  signal: AbortSignal;
  evidence: (name: string, value: unknown) => Promise<void>;
};

export function createCodexErasurePreview(context: Context): {
  tool: CodexAppServerPreviewTool;
  verify: (value: unknown) => Plans;
} {
  let revision = 0;
  let latest: PreviewArtifact | undefined;
  let failure: Error | undefined;
  const tool: CodexAppServerPreviewTool = {
    inputSchema: typesettingOutputSchema("erase-preview"),
    execute: async (value) => {
      context.signal.throwIfAborted();
      if (++revision > 1)
        throw new Error("제거 미리보기는 한 번만 실행합니다.");
      try {
        const plans = validatePlans(value, context.reading);
        const resolved = renderErasurePreviews(context, plans);
        const artifact = {
          revision,
          sha256: geometryHash(resolved.plans),
          plans: resolved.plans,
          unresolvedRegionIds: resolved.issues.map((issue) => issue.regionId),
        };
        await context.evidence(`mask-preview-${context.stage}-${revision}`, {
          ...artifact,
          proposedPlans: plans,
          issues: resolved.issues,
          images: resolved.images,
        });
        context.signal.throwIfAborted();
        latest = artifact;
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                revision: artifact.revision,
                sha256: artifact.sha256,
                unresolvedRegionIds: artifact.unresolvedRegionIds,
                issues: resolved.issues,
                instruction:
                  "Inspect every image. Report incomplete coverage, artwork intrusion and region-specific unresolved issues. Do not retry this tool; this is the only proposal. Unresolved targets have empty permission and preserve source, not successful erasure. Finalize only this revision, sha256 and exact unresolvedRegionIds. The app applies this bound artifact, never retranscribed polygons.",
              }),
            },
            ...resolved.images.flatMap((image) => [
              { type: "inputText" as const, text: image.label },
              { type: "inputImage" as const, imageUrl: image.dataUrl },
            ]),
          ],
        };
      } catch (error) {
        failure = new Error(
          `제거 미리보기 생성 실패: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        throw failure;
      }
    },
  };
  return {
    tool,
    verify: (value) => resolvePreview(context.signal, value, latest, failure),
  };
}

function resolvePreview(
  signal: AbortSignal,
  value: unknown,
  latest: PreviewArtifact | undefined,
  failure: Error | undefined,
): Plans {
  signal.throwIfAborted();
  if (!latest)
    throw failure ?? new Error("Codex가 제거 미리보기를 실행하지 않았습니다.");
  const commit = erasureCommitSchema.parse(value);
  if (commit.revision !== latest.revision || commit.sha256 !== latest.sha256)
    throw new Error("마지막 실제 제거 미리보기의 번호·해시와 다릅니다.");
  assertExactMembership(
    latest.unresolvedRegionIds,
    commit.unresolvedRegionIds,
    "Unresolved erasure acknowledgement",
  );
  return structuredClone(latest.plans);
}

function validatePlans(value: unknown, reading: CodexPageReading): Plans {
  const plans = erasurePlansSchema.parse(value);
  assertExactMembership(
    reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id),
    plans.regions.map((region) => region.regionId),
    "Erasure preview",
  );
  return plans;
}

function geometryHash(plans: Plans): string {
  const regions = plans.regions
    .map(({ regionId, background, erasePolygons }) => ({
      regionId,
      background,
      erasePolygons: erasePolygons.map((polygon) =>
        polygon.map(({ x, y }) => ({ x, y })),
      ),
    }))
    .sort((a, b) => a.regionId.localeCompare(b.regionId));
  return createHash("sha256").update(JSON.stringify(regions)).digest("hex");
}

function renderErasurePreviews(context: Context, plans: Plans) {
  const active = context.reading.regions.filter(
    (region) => region.action !== "keep",
  );
  if (context.images.length !== active.length)
    throw new Error("원문 crop 목록이 제거 대상과 다릅니다.");
  const resolved = active.map((region, index) => {
    const plan = plans.regions.find((item) => item.regionId === region.id);
    if (!plan) throw new Error("제거 계획에 원문 영역이 없습니다.");
    return resolveRegionPreview(context, region, context.images[index], plan);
  });
  return {
    plans: { regions: resolved.map((item) => item.plan) },
    images: resolved.flatMap((item) => item.images),
    issues: resolved.flatMap((item) => (item.issue ? [item.issue] : [])),
  };
}

function resolveRegionPreview(
  context: Context,
  region: CodexPageRegion,
  input: TypesettingImage,
  plan: Plans["regions"][number],
) {
  try {
    const images = renderRegionPreview(context, region, input, plan);
    const issue = plan.erasePolygons.length
      ? undefined
      : {
          regionId: region.id,
          reason:
            "Empty permission; original source is unresolved and preserved.",
        };
    return { plan, images, issue };
  } catch (error) {
    if (!(error instanceof CodexEraseMaskError)) throw error;
    const protectedSource = protectedPreviewSource(
      context,
      region,
      error.protectedRegionId,
    );
    const issue = {
      regionId: region.id,
      reason: error.message,
      protectedSource,
    };
    return {
      plan: { ...plan, erasePolygons: [], reason: error.message },
      images: [
        {
          ...input,
          label: input.label + "; UNRESOLVED: " + JSON.stringify(issue),
        },
      ],
      issue,
    };
  }
}

function protectedPreviewSource(
  context: Context,
  region: CodexPageRegion,
  protectedId: string | undefined,
) {
  const protectedRegion = context.reading.regions.find(
    (item) => item.id === protectedId,
  );
  if (!protectedRegion) return undefined;
  const crop = codexSourceContextRect(region, context.page);
  const rect = normalizedRegionToPixelRect(
    protectedRegion.sourceBbox,
    context.page,
  );
  return {
    regionId: protectedRegion.id,
    sourceText: protectedRegion.sourceText,
    contextBbox: {
      x: ((rect.x - crop.x) / crop.w) * 1000,
      y: ((rect.y - crop.y) / crop.h) * 1000,
      w: (rect.w / crop.w) * 1000,
      h: (rect.h / crop.h) * 1000,
    },
  };
}

function renderRegionPreview(
  context: Context,
  region: CodexPageRegion,
  input: TypesettingImage,
  plan: Plans["regions"][number],
): TypesettingImage[] {
  if (!input.label.startsWith(`${region.id}; original context crop`))
    throw new Error("제거 미리보기의 원문 crop ID가 다릅니다.");
  const crop = codexSourceContextRect(region, context.page);
  const source = PNG.sync.read(
    Buffer.from(input.dataUrl.split(",")[1], "base64"),
  );
  if (source.width !== crop.w || source.height !== crop.h)
    throw new Error("제거 미리보기의 원문 해상도가 다릅니다.");
  if (!plan.erasePolygons.length)
    return [
      {
        ...input,
        label:
          input.label + "; UNRESOLVED: empty permission; original preserved.",
      },
    ];
  const refined = refineCodexSourceRegion(
    region,
    context.page,
    plan.erasePolygons,
  );
  const mask = createCodexEraseMask(
    refined,
    context.page,
    context.reading.regions.filter((item) => item.action === "keep"),
  );
  const local = {
    ...mask,
    bounds: {
      ...mask.bounds,
      x: mask.bounds.x - crop.x,
      y: mask.bounds.y - crop.y,
    },
  };
  const overlay = PNG.sync.read(PNG.sync.write(source));
  tintPermission(overlay, local);
  const images = [
    input,
    pngImage(
      overlay,
      input.label +
        "; RED overlay = exact allowed pixels, not restored artwork.",
    ),
  ];
  if (plan.background !== "artwork") {
    fillPlainMask(source, local, plan.background === "white" ? 255 : 0);
    images.push(
      pngImage(
        source,
        input.label +
          `; ACTUAL ${plan.background} erase preview. Inspect residual letters and erased artwork.`,
      ),
    );
  }
  return images;
}

function pngImage(image: PNG, label: string): TypesettingImage {
  return {
    label,
    dataUrl:
      "data:image/png;base64," + PNG.sync.write(image).toString("base64"),
  };
}

function tintPermission(
  image: PNG,
  mask: ReturnType<typeof createCodexEraseMask>,
): void {
  for (let y = 0; y < mask.bounds.h; y++) {
    for (let x = 0; x < mask.bounds.w; x++) {
      if (!mask.data[y * mask.bounds.w + x]) continue;
      const offset =
        ((y + mask.bounds.y) * image.width + x + mask.bounds.x) * 4;
      image.data[offset] = Math.round(image.data[offset] * 0.55 + 255 * 0.45);
      image.data[offset + 1] = Math.round(image.data[offset + 1] * 0.55);
      image.data[offset + 2] = Math.round(image.data[offset + 2] * 0.55);
    }
  }
}

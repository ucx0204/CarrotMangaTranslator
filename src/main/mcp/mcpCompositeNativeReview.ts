import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  McpCompositeRenderEvidenceSchema,
  type McpCompositeRenderEvidence,
} from "../../shared/mcpCompositeWorkflowReview";
import type {
  McpCompositeGuard,
  McpCompositeNative,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { readImageRedactionState } from "../imageRedactionStore";
import type { McpTool } from "./mcpReadTools";
import { invokeMcpCompositeNativeTool } from "./mcpCompositeNativeTools";
import {
  readMcpCompositeSources,
  type McpCompositeSourceOptions,
} from "./mcpCompositeNativePages";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const LIFETIME = 10 * 60_000;
const imageMetadata = z.object({
  chapterId: z.string(),
  pageId: z.string(),
  revision: z.string(),
  kind: z.literal("rendered-page"),
  sourceWidth: z.number().positive(),
  sourceHeight: z.number().positive(),
  crop: z.null(),
  width: z.number().int().positive().max(1600),
  height: z.number().int().positive().max(1600),
  pixelMapping: McpCompositeRenderEvidenceSchema.shape.pixelMapping,
});
type Issued = {
  evidence: McpCompositeRenderEvidence;
  bytes: Buffer;
  retrieved: boolean;
};

/** Session preview evidence only. No retained export, delivery event or host verdict is invented. */
export class McpCompositeNativeReview {
  private readonly issued = new Map<string, Issued>();
  private stopped = false;
  constructor(
    private readonly tools: readonly McpTool[],
    private readonly sources: McpCompositeSourceOptions,
    private readonly now: () => number = Date.now,
  ) {}
  renderEvidence: McpCompositeNative["renderEvidence"] = async (
    record,
    phaseId,
    pass,
    signal,
    guard,
  ) => {
    this.assertOpen();
    signal.throwIfAborted();
    await assertReviewImageAccess(guard);
    const before = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    assertSnapshot(record, before.snapshot.fingerprint);
    const issued: Issued[] = [];
    let bytes = 0;
    for (const page of before.snapshot.pages) {
      signal.throwIfAborted();
      const captured = await this.render(record, phaseId, pass, page, guard);
      bytes += captured.bytes.length;
      if (bytes > MAX_CACHE_BYTES) throw capacity();
      issued.push(captured);
    }
    signal.throwIfAborted();
    const after = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    assertSnapshot(record, after.snapshot.fingerprint);
    this.assertOpen();
    await assertReviewImageAccess(guard);
    this.assertOpen();
    signal.throwIfAborted();
    this.admit(issued);
    return issued.map((item) => structuredClone(item.evidence));
  };
  private async render(
    record: McpCompositeRecord,
    phaseId: string,
    pass: number,
    page: McpCompositeRecord["snapshot"]["pages"][number],
    guard: McpCompositeGuard,
  ): Promise<Issued> {
    const result = await invokeMcpCompositeNativeTool(
      this.tools,
      "carrot_render_page_preview",
      { chapterId: page.chapterId, pageId: page.pageId },
      record.owner,
      guard,
    );
    const metadata = imageMetadata.parse(result.structuredContent);
    if (
      metadata.chapterId !== page.chapterId ||
      metadata.pageId !== page.pageId ||
      metadata.revision !== page.revision
    )
      throw stale();
    const bytes = renderedBytes(result.content, metadata);
    const {
      blockIds: _blocks,
      membershipFingerprint: _membership,
      memoryFingerprint: _memory,
      ...identity
    } = page;
    const evidence = McpCompositeRenderEvidenceSchema.parse({
      ...identity,
      id: randomUUID(),
      owner: record.owner,
      compositeId: record.id,
      phaseId,
      pass,
      kind: "rendered-page",
      fontEvidence: {
        appManaged: "bytes-sha256",
        systemFallback: "native-render-pixels-only",
      },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: metadata.width,
      height: metadata.height,
      pixelMapping: metadata.pixelMapping,
      createdAt: this.now(),
      renderOptionsFingerprint: compositeFingerprint({
        tool: "carrot_render_page_preview",
        maximumSide: 1600,
        format: "png",
      }),
    });
    return { evidence, bytes, retrieved: false };
  }
  async readEvidence(
    record: McpCompositeRecord,
    evidenceId: string,
    guard: McpCompositeGuard,
  ) {
    const item = this.lookup(record, evidenceId);
    const target = record.targets.find(
      (page) =>
        page.chapterId === item.evidence.chapterId &&
        page.pageId === item.evidence.pageId,
    );
    if (!target) throw stale();
    await assertReviewImageAccess(guard);
    const current = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    assertSnapshot(record, current.snapshot.fingerprint);
    assertPageEvidence(
      current.snapshot.pages.find(
        (page) =>
          page.chapterId === target.chapterId && page.pageId === target.pageId,
      ),
      item.evidence,
    );
    this.lookup(record, evidenceId);
    await assertReviewImageAccess(guard);
    this.lookup(record, evidenceId);
    item.retrieved = true;
    return {
      evidence: structuredClone(item.evidence),
      bytes: Buffer.from(item.bytes),
    };
  }
  verifyEvidence: McpCompositeNative["verifyEvidence"] = async (
    record,
    evidence,
    guard,
  ) => {
    await assertReviewImageAccess(guard);
    for (const value of evidence) {
      const item = this.lookup(record, value.id);
      if (!item.retrieved)
        throw new McpEditError(
          "invalid_edit",
          "Retrieve each issued actual PNG before submitting its host visual review; metadata alone is insufficient.",
        );
      if (compositeFingerprint(item.evidence) !== compositeFingerprint(value))
        throw stale();
    }
    const current = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    assertSnapshot(record, current.snapshot.fingerprint);
    for (const value of evidence)
      assertPageEvidence(
        current.snapshot.pages.find(
          (page) =>
            page.chapterId === value.chapterId && page.pageId === value.pageId,
        ),
        value,
      );
    await assertReviewImageAccess(guard);
    for (const value of evidence) this.lookup(record, value.id);
  };
  verifyReviewReport: McpCompositeNative["verifyReviewReport"] = async (
    record,
    report,
    guard,
  ) => {
    const current = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    assertSnapshot(record, current.snapshot.fingerprint);
    for (const finding of report.findings) {
      const value = current.values.find(
        ({ target }) =>
          target.chapterId === finding.chapterId &&
          target.pageId === finding.pageId,
      );
      if (!value) throw stale();
      if (
        finding.blockId &&
        (!value.page.blocks.some((block) => block.id === finding.blockId) ||
          (value.target.blockIds.length &&
            !value.target.blockIds.includes(finding.blockId)))
      )
        throw new McpEditError(
          "invalid_edit",
          "A review finding is outside the current authorized saved block selection.",
        );
    }
    await assertReviewImageAccess(guard);
    for (const assessment of report.assessments) {
      const { evidence } = this.lookup(record, assessment.evidenceId);
      if (evidence.phaseId !== report.phaseId || evidence.pass !== report.pass)
        throw stale();
    }
  };
  close() {
    this.stopped = true;
    this.issued.clear();
  }
  private assertOpen() {
    if (this.stopped) throw stale();
  }
  private lookup(record: McpCompositeRecord, id: string) {
    this.assertOpen();
    const item = this.issued.get(id);
    if (
      !item ||
      item.evidence.owner !== record.owner ||
      item.evidence.compositeId !== record.id ||
      item.evidence.createdAt + LIFETIME <= this.now() ||
      !record.phases.some(
        (phase) =>
          phase.id === item.evidence.phaseId &&
          phase.evidence?.some((value) => value.id === id),
      )
    )
      throw stale();
    return item;
  }
  private admit(values: Issued[]) {
    for (const [id, item] of this.issued)
      if (item.evidence.createdAt + LIFETIME <= this.now())
        this.issued.delete(id);
    const incoming = values.reduce((sum, item) => sum + item.bytes.length, 0);
    let used = [...this.issued.values()].reduce(
      (sum, item) => sum + item.bytes.length,
      0,
    );
    for (const [id, item] of this.issued) {
      if (
        this.issued.size + values.length <= 50 &&
        used + incoming <= MAX_CACHE_BYTES
      )
        break;
      this.issued.delete(id);
      used -= item.bytes.length;
    }
    if (values.length > 50 || incoming > MAX_CACHE_BYTES) throw capacity();
    for (const item of values) this.issued.set(item.evidence.id, item);
  }
}
function renderedBytes(
  content: Awaited<ReturnType<McpTool["invoke"]>>,
  metadata: z.infer<typeof imageMetadata>,
) {
  const images = content.filter((item) => item.type === "image");
  const image = images[0];
  if (
    images.length !== 1 ||
    image?.type !== "image" ||
    image.mimeType !== "image/png" ||
    image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  )
    throw capacity();
  const bytes = Buffer.from(image.data, "base64");
  if (
    bytes.length < 24 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString("base64") !== image.data ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) !== metadata.width ||
    bytes.readUInt32BE(20) !== metadata.height
  )
    throw stale();
  return bytes;
}
function assertSnapshot(record: McpCompositeRecord, fingerprint: string) {
  if (record.snapshot.fingerprint !== fingerprint) throw stale();
}
function assertPageEvidence(
  page: McpCompositeRecord["snapshot"]["pages"][number] | undefined,
  evidence: McpCompositeRenderEvidence,
) {
  if (
    !page ||
    [
      "workId",
      "chapterId",
      "pageId",
      "revision",
      "reviewRevision",
      "sourceFingerprint",
      "contextFingerprint",
      "settingsFingerprint",
      "fontFingerprint",
    ].some(
      (key) =>
        page[key as keyof typeof page] !==
        evidence[key as keyof McpCompositeRenderEvidence],
    )
  )
    throw stale();
}
function stale() {
  return new McpEditError(
    "revision_conflict",
    "Issued composite render evidence is unavailable or no longer matches current native sources.",
  );
}
function capacity() {
  return new McpEditError(
    "invalid_edit",
    "Composite review PNG evidence is bounded to 4 MiB per page, 50 images and 128 MiB per session.",
  );
}
async function assertReviewImageAccess(guard: McpCompositeGuard) {
  guard(["carrot.read", "carrot.images"]);
  if ((await readImageRedactionState()).enabled)
    throw new McpEditError(
      "access_denied",
      "Composite review image transfer is blocked by image redaction review.",
    );
  guard(["carrot.read", "carrot.images"]);
}

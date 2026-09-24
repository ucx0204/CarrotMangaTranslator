import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../src/shared/pageRevision";
import {
  compositeFingerprint,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "../src/main/application/mcpCompositeWorkflowRecord";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import { editingChapter } from "./mcpEditing.fixture";

export function compositeMetadataFixture(count = 1) {
  const chapter = editingChapter();
  const original = chapter.pages[0];
  chapter.pages = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(original),
    id: `page-${index}`,
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const targets = chapter.pages.map((page) => ({
    workId: chapter.workId,
    chapterId: chapter.id,
    pageId: page.id,
    blockIds: [page.blocks[0].id],
  }));
  const digest = "a".repeat(64);
  const now = Date.now();
  const plan = McpCompositePrepareSchema.parse({
    requestId: randomUUID(),
    reason: "Selected metadata inspection",
    targets: count
      ? { kind: "saved", pages: targets }
      : {
          kind: "reviewed-import",
          phaseId: "import",
          selectionFingerprint: digest,
          itemKeys: [digest],
          maxPages: 1,
          maxChapters: 1,
        },
    phases: count
      ? [{ id: "review", kind: "review" }]
      : [
          {
            id: "import",
            kind: "native",
            action: "import-create",
            role: "work",
          },
        ],
    maxReviewPasses: 1,
    budgets: {
      admissions: 2,
      pageAttempts: 50,
      translationRequests: 0,
      researchAttempts: 0,
      selectedEdits: 0,
      models: zeroCompositeCost().models,
    },
  });
  const record = parseCompositeRecord({
    format: 1,
    kind: "composite-workflow",
    id: randomUUID(),
    owner: "metadata-owner",
    version: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 7 * 24 * 60 * 60_000,
    plan,
    initialFingerprint: compositeFingerprint(plan),
    status: "prepared",
    targets,
    snapshot: {
      fingerprint: digest,
      policyFingerprint: digest,
      pages: chapter.pages.map((page, index) => ({
        ...targets[index],
        revision: createPageRevision(page),
        reviewRevision: createSoundEffectReviewPageRevision(page),
        sourceFingerprint: digest,
        contextFingerprint: digest,
        settingsFingerprint: digest,
        fontFingerprint: digest,
        membershipFingerprint: digest,
        memoryFingerprint: digest,
      })),
    },
    phases: plan.phases.map(({ id }) => ({ id, status: "unbound" })),
    used: zeroCompositeCost(),
    usageUnknown: false,
    reviewPairs: [],
    actions: [],
  });
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const verifySources = vi.fn(async () => undefined);
  return {
    chapter,
    record,
    ports: { openChapter, verifySources },
    guard: vi.fn(() => undefined),
  };
}

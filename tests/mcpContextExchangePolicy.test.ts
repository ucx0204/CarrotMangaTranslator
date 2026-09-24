import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { migrationFixture } from "./mcpContextMigration.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { MCP_EXCHANGE_BYTES } from "../src/shared/mcpExchangeFiles";
import {
  McpContextImportApplySchema,
  McpContextImportPreviewSchema,
  type McpContextImportSelection,
} from "../src/shared/mcpContextExchange";
import {
  decodeMcpContextExchangePayload,
  encodeMcpContextExchangePayload,
  parseMcpContextExchangePayload,
} from "../src/shared/mcpContextExchangePayload";
import { prepareMcpContextImport } from "../src/main/application/mcpContextExchangePolicy";
import { planMcpContextChanges } from "../src/main/application/mcpContextEditPolicy";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

const now = "2026-09-23T14:00:00.000Z";
function fixture(
  selections: McpContextImportSelection[] = [
    {
      changeId: "__proto__",
      entity: "glossary",
      entryId: "old",
      fields: ["target", "enabled"],
    },
  ],
) {
  const { graph } = migrationFixture();
  const payload = parseMcpContextExchangePayload({
    format: "carrot-work-context",
    version: 1,
    source: {
      kind: "context",
      workId: "work",
      chapterId: "chapter",
      scope: "guide-and-memory",
      snapshot: "0".repeat(16),
    },
    guide: structuredClone(graph.styleGuide),
    memory: structuredClone(graph.chapters[0].storyMemory),
  });
  const input = McpContextImportPreviewSchema.parse({
    chapterId: "chapter",
    requestId: randomUUID(),
    uploadId: randomUUID(),
    selections,
  });
  const digest = () =>
    createHash("sha256")
      .update(encodeMcpContextExchangePayload(payload))
      .digest("hex");
  const preview = () =>
    prepareMcpContextImport(graph, payload, digest(), input, now, () => {});
  return { graph, payload, input, digest, preview };
}

it("matches the native partial policy and preserves unselected fields, origins and IDs", () => {
  const f = fixture();
  const original = structuredClone(f.graph);
  if (!f.payload.guide) throw new Error("Expected guide fixture");
  Object.assign(f.payload.guide.glossary[0], {
    target: "",
    enabled: false,
    origin: "manual",
    updatedAt: "forged",
  });
  const reviewed = f.preview();
  const snapshot = {
    workId: f.graph.workId,
    workTitle: f.graph.workTitle,
    styleGuide: f.graph.styleGuide,
    ...f.graph.chapters[0],
  };
  const native = planMcpContextChanges(
    snapshot,
    {
      chapterId: "chapter",
      requestId: f.input.requestId,
      revision: mcpContextRevision(snapshot),
      changes: [
        {
          changeId: "__proto__",
          entity: "glossary",
          entryId: "old",
          values: { target: "", enabled: false },
        },
      ],
    },
    { now, origin: "manual", entryIds: {} },
  );
  expect(reviewed.delta.guide?.after).toEqual(native.styleGuide);
  expect(reviewed.delta.guide?.after.glossary[0]).toMatchObject({
    id: "old",
    target: "",
    enabled: false,
    origin: "ai",
    createdAt: "initial",
    updatedAt: now,
  });
  expect(reviewed.changes[0].after).toEqual({ target: "", enabled: false });
  expect(reviewed.delta.pages).toEqual([]);
  expect(reviewed.delta.memories).toEqual([]);
  expect(f.graph).toEqual(original);
});

it("applies manual memory fields through native provenance policy without importing digests or evidence", () => {
  const f = fixture();
  const current = f.graph.chapters[0].storyMemory.pages[0];
  current.visualSummary = "Original visual summary";
  current.visualSummarySource = "ai";
  current.textEvidence = {
    version: 1,
    method: "native-excerpt",
    sourceFingerprint: "1".repeat(16),
    translationFingerprint: "2".repeat(16),
    contextFingerprint: "3".repeat(16),
    summaryFingerprint: "4".repeat(16),
  };
  f.payload.memory = structuredClone(f.graph.chapters[0].storyMemory);
  Object.assign(f.payload.memory.pages[0], {
    summary: "Reviewed summary",
    visualSummary: "Human selected visual summary",
    sourceDigest: "forged source",
    translatedDigest: "forged translation",
    textEvidence: { ...current.textEvidence, method: "reviewed-page-text" },
  });
  f.input.selections = [
    {
      changeId: "memory",
      entity: "memory",
      pageId: "page",
      pageRevision: createPageRevision(f.graph.chapters[0].chapter.pages[0]),
      fields: ["summary", "visualSummary", "glossaryEntryIds"],
    },
  ];
  const reviewed = f.preview();
  const after = reviewed.delta.memories[0].after.pages[0];
  expect(after).toMatchObject({
    summary: "Reviewed summary",
    visualSummary: "Human selected visual summary",
    visualSummarySource: "manual",
    sourceDigest: current.sourceDigest,
    translatedDigest: current.translatedDigest,
    textEvidence: current.textEvidence,
  });
  expect(reviewed.changes[0].after.visualSummarySource).toBe("manual");
  expect(reviewed.changes[0].after).not.toHaveProperty("sourceDigest");
  expect(reviewed.diagnostics).toContainEqual(
    expect.objectContaining({ category: "manual-visual-summary", count: 1 }),
  );
  expect(reviewed.delta.guide).toBeUndefined();
  expect(reviewed.delta.pages).toEqual([]);
});

it("requires summary for a new native memory and rejects stale page revisions and orphan selections", () => {
  const f = fixture();
  f.graph.chapters[0].storyMemory.pages = [];
  if (!f.payload.memory) throw new Error("Expected memory fixture");
  f.payload.memory.pages[0].visualSummary = "Selected visual";
  const memory = {
    changeId: "memory",
    entity: "memory" as const,
    pageId: "page",
    pageRevision: createPageRevision(f.graph.chapters[0].chapter.pages[0]),
    fields: ["summary" as const],
  };
  f.input.selections = [memory];
  const reviewed = f.preview();
  expect(reviewed.delta.memories[0].after.pages[0]).toMatchObject({
    pageId: "page",
    sourceDigest: "",
    translatedDigest: "",
  });
  f.input.selections = [{ ...memory, fields: ["visualSummary"] }];
  expect(f.preview).toThrow(/summary/);
  f.input.selections = [
    { ...memory, pageRevision: "page-v1:0000000000000000" },
  ];
  expect(f.preview).toThrow(/Page changed/);
  f.input.selections = [{ ...memory, pageId: "orphan" }];
  expect(f.preview).toThrow(/saved page/);
});

it("binds pagination and selected apply to upload bytes and the complete native graph", () => {
  const f = fixture([
    {
      changeId: "term",
      entity: "glossary",
      entryId: "old",
      fields: ["target"],
    },
    { changeId: "rules", entity: "rules", fields: ["honorifics"] },
  ]);
  if (!f.payload.guide) throw new Error("Expected guide fixture");
  f.payload.guide.glossary[0].target = "updated";
  f.payload.guide.rules.honorifics = "drop";
  const reviewed = f.preview();
  const input = McpContextImportApplySchema.parse({
    chapterId: f.input.chapterId,
    uploadId: f.input.uploadId,
    requestId: f.input.requestId,
    selections: f.input.selections,
    sourceSha256: f.digest(),
    referenceSnapshot: reviewed.referenceSnapshot,
    planFingerprint: reviewed.planFingerprint,
    selectedChangeIds: ["term"],
  });
  const apply = () =>
    prepareMcpContextImport(
      f.graph,
      f.payload,
      f.digest(),
      input,
      now,
      () => {},
    );
  expect(apply().delta.guide?.after.rules).toEqual(f.graph.styleGuide.rules);
  expect(
    prepareMcpContextImport(
      f.graph,
      f.payload,
      f.digest(),
      f.input,
      "2027-01-01T00:00:00.000Z",
      () => {},
    ).planFingerprint,
  ).toBe(reviewed.planFingerprint);
  f.graph.chapters[1].chapter.pages[0].blocks[0].translatedText =
    "unselected chapter changed";
  expect(apply).toThrow(/Preview again/);
  expect(
    McpContextImportPreviewSchema.safeParse({ ...f.input, offset: 1 }).success,
  ).toBe(false);
});

it("rejects unsupported fields, new identities, ambiguous rows and omitted optional values", () => {
  const f = fixture();
  for (const fields of [["origin"], ["target", "target"]])
    expect(
      McpContextImportPreviewSchema.safeParse({
        ...f.input,
        selections: [{ ...f.input.selections[0], fields }],
      }).success,
    ).toBe(false);
  f.input.selections = [
    { changeId: "note", entity: "glossary", entryId: "old", fields: ["note"] },
  ];
  expect(f.preview).toThrow(/absent/);
  f.input.selections = [
    {
      changeId: "new",
      entity: "glossary",
      entryId: "new-id",
      fields: ["target"],
    },
  ];
  expect(f.preview).toThrow(/exactly once/);
  if (!f.payload.guide) throw new Error("Expected guide fixture");
  f.payload.guide.glossary.push(structuredClone(f.payload.guide.glossary[0]));
  f.input.selections = [
    {
      changeId: "duplicate",
      entity: "glossary",
      entryId: "old",
      fields: ["target"],
    },
  ];
  expect(f.preview).toThrow(/exactly once/);
  const foreign = {
    ...f.payload,
    source: { ...f.payload.source, workId: "foreign" },
  };
  expect(() => parseMcpContextExchangePayload(foreign)).toThrow(
    /native version-one/,
  );
  expect(() =>
    parseMcpContextExchangePayload({ ...f.payload, source: null }),
  ).toThrow(/native version-one/);
});

it("uses strict JSON/native schemas and reports existing native compatibility normalization", () => {
  const f = fixture();
  const raw = JSON.parse(
    Buffer.from(encodeMcpContextExchangePayload(f.payload)).toString(),
  );
  raw.guide.rules.defaultTone = "webtoon";
  const decoded = decodeMcpContextExchangePayload(
    Buffer.from(JSON.stringify(raw)),
  );
  expect(decoded.payload.guide?.rules.defaultTone).toBe("natural_korean");
  expect(decoded.nativeNormalization).toBe(true);
  expect(
    decodeMcpContextExchangePayload(encodeMcpContextExchangePayload(f.payload))
      .nativeNormalization,
  ).toBe(false);
  for (const bytes of [
    Buffer.from("```json\n{}\n```"),
    Buffer.from([0xff]),
    Buffer.from('{"format":/*repair*/1}'),
  ])
    expect(() => decodeMcpContextExchangePayload(bytes)).toThrow(
      /exact UTF-8 JSON/,
    );
  expect(() =>
    parseMcpContextExchangePayload({ ...f.payload, privatePath: "/private" }),
  ).toThrow(/native version-one/);
});

it("rejects actual UTF-8 input and expanded canonical JSON above the same four-MiB cap", () => {
  expect(() =>
    decodeMcpContextExchangePayload(Buffer.alloc(MCP_EXCHANGE_BYTES + 1)),
  ).toThrow(/four-MiB/);
  const f = fixture();
  if (!f.payload.memory) throw new Error("Expected memory fixture");
  f.payload.memory.pages = Array.from({ length: 1000 }, (_, index) => ({
    pageId: `row-${index}`,
    pageName: "p",
    pageIndex: 0,
    sourceDigest: "s".repeat(2000),
    translatedDigest: "t".repeat(1010),
    summary: "m".repeat(1000),
    updatedAt: "t",
  }));
  const compact = Buffer.from(JSON.stringify(f.payload));
  expect(compact.length).toBeLessThanOrEqual(MCP_EXCHANGE_BYTES);
  expect(
    Buffer.byteLength(`${JSON.stringify(f.payload, null, 2)}\n`),
  ).toBeGreaterThan(MCP_EXCHANGE_BYTES);
  expect(() => decodeMcpContextExchangePayload(compact)).toThrow(/four-MiB/);
});

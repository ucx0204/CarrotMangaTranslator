import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import {
  compositeFingerprint,
  reserveCompositeCost,
  zeroCompositeCost,
  applyCompositeImport,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import { McpCompositeRecordSchema } from "../src/main/application/mcpCompositeWorkflowRecord";
import {
  compositeFixture,
  compositePlan,
  guard,
  owner,
  hash,
} from "./mcpCompositeWorkflow.fixture";

it("caps cumulative selected edits at one hundred per qualified page across native phases", async () => {
  const f = compositeFixture();
  const plan = compositePlan();
  plan.budgets.selectedEdits = 5000;
  const record = await f.service.prepare(owner, plan, guard);
  const cost = zeroCompositeCost();
  cost.admissions = 1;
  cost.selectedEdits = 60;
  cost.pageEdits = [{ chapterId: "chapter", pageId: "page", edits: 60 }];
  reserveCompositeCost(record, cost);
  expect(record.used.selectedEdits).toBe(60);
  expect(() => reserveCompositeCost(record, cost)).toThrow("budget");
  expect(record.used.selectedEdits).toBe(60);
  expect(record.used.admissions).toBe(1);
});

it("accepts only exact ordered reviewed-item mappings and rejects fabricated or duplicate saved pages", async () => {
  const f = compositeFixture();
  const plan = McpCompositePrepareSchema.parse({
    ...compositePlan(),
    targets: {
      kind: "reviewed-import",
      phaseId: "import",
      selectionFingerprint: hash(),
      itemKeys: [hash("b"), hash("c")],
      maxChapters: 1,
      maxPages: 2,
    },
    phases: [{ kind: "native", id: "import", action: "import-create" }],
  });
  const record = await f.service.prepare(owner, plan, guard);
  const page = {
    workId: "work",
    chapterId: "chapter",
    pageId: "page",
    blockIds: [],
  };
  const outcome = {
    status: "completed" as const,
    resultFingerprint: hash(),
    receipt: {
      kind: "import" as const,
      id: randomUUID(),
      requestId: randomUUID(),
      family: "import-create" as const,
      inputFingerprint: hash(),
    },
    imported: {
      selectionFingerprint: hash(),
      items: [
        { itemKey: hash("c"), page },
        { itemKey: hash("b"), page: { ...page, pageId: "page-two" } },
      ],
    },
  };
  expect(() => applyCompositeImport(record, outcome)).toThrow("exact reviewed");
  outcome.imported.items.reverse();
  outcome.imported.items[1].page = outcome.imported.items[0].page;
  expect(() => applyCompositeImport(record, outcome)).toThrow();
  expect(record.targets).toEqual([]);
});

it("strict durable records reject native payloads and successful-looking receipts without admission", async () => {
  const f = compositeFixture();
  const record = await f.service.prepare(owner, compositePlan(), guard);
  const corrupted = structuredClone(record);
  corrupted.phases[0].status = "completed";
  const receipt = {
    kind: "workflow" as const,
    id: randomUUID(),
    requestId: randomUUID(),
    family: "workflow-run" as const,
    inputFingerprint: hash(),
  };
  corrupted.phases[0].child = receipt;
  corrupted.phases[0].outcome = {
    status: "completed",
    receipt,
    resultFingerprint: hash(),
  };
  expect(McpCompositeRecordSchema.safeParse(corrupted).success).toBe(false);
  expect(
    McpCompositeRecordSchema.safeParse({
      ...record,
      rawAction: { input: { secret: "do not retain" } },
    }).success,
  ).toBe(false);
  expect(compositeFingerprint({ a: 1, Z: 2, nested: { c: 3, B: 4 } })).toBe(
    compositeFingerprint({ nested: { B: 4, c: 3 }, Z: 2, a: 1 }),
  );
});

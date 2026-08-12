import { describe, expect, it } from "vitest";

type PageRelativeRoleQaAuditModule = {
  summarizePageRelativeRoleQa: (
    trace: unknown,
  ) => Record<string, unknown> | null;
};

const { summarizePageRelativeRoleQa } =
  require("../scripts/library-full-pipeline-qa/page-relative-role-qa-audit.cjs") as PageRelativeRoleQaAuditModule;

describe("library page-relative role QA audit", () => {
  it("fails closed when any inferred row is missing its QA audit", () => {
    expect(() =>
      summarizePageRelativeRoleQa({
        qaPageRelativeRoleReroute: true,
        pixelInference: [
          { blockId: "audited", pageRelativeRoleQa: audit("applied") },
          { blockId: "missing" },
        ],
      }),
    ).toThrow("audit is missing for inference row: missing");
  });

  it("separates planned changes from changes that survived the guard", () => {
    const summary = summarizePageRelativeRoleQa({
      qaPageRelativeRoleReroute: true,
      pixelInference: [
        {
          blockId: "applied-role",
          pageRelativeRoleQa: audit("applied", {
            projectedRole: "dialogue",
            clusterBodyAnchorFontId: "ridi-batang",
            baselinePageConsistencyState: {
              mode: "page_anchor",
              anchorFontId: "ridi-batang",
            },
          }),
        },
        {
          blockId: "reverted-role",
          pageRelativeRoleQa: audit("reverted_apply_rate_guard", {
            projectedRole: "dialogue",
          }),
        },
        {
          blockId: "applied-peer",
          pageRelativeRoleQa: audit("applied", {
            preferredPeerFontId: "gaegu",
          }),
        },
        {
          blockId: "reverted-peer",
          pageRelativeRoleQa: audit("reverted_apply_rate_guard", {
            preferredPeerFontId: "dohyeon",
          }),
        },
      ],
    });

    expect(summary).toMatchObject({
      inferredRows: 4,
      plannedRoleChanges: 2,
      effectiveRoleChanges: 1,
      plannedPeerPreferences: 2,
      effectivePeerPreferences: 1,
      plannedClusterBodyAnchorRows: 1,
      baselinePageStateRows: 1,
      statusCounts: { applied: 2, reverted_apply_rate_guard: 2 },
    });
    expect(summary).not.toHaveProperty("clusterBodyAnchorRows");
    expect(summary).not.toHaveProperty("effectiveClusterBodyAnchorRows");
  });

  it("rejects stale v1 audit rows in a v2 trace", () => {
    expect(() =>
      summarizePageRelativeRoleQa({
        qaPageRelativeRoleReroute: true,
        pixelInference: [
          {
            blockId: "stale-v1",
            pageRelativeRoleQa: audit("applied", {
              policyVersion: "font-matching-page-relative-role-qa-v1",
            }),
          },
        ],
      }),
    ).toThrow("policy version mismatch");
  });

  it("returns null when the QA reroute was not explicitly enabled", () => {
    expect(
      summarizePageRelativeRoleQa({
        qaPageRelativeRoleReroute: false,
        pixelInference: [{ blockId: "ordinary" }],
      }),
    ).toBeNull();
  });
});

function audit(
  status: "applied" | "reverted_apply_rate_guard",
  overrides: Partial<{
    projectedRole: string;
    policyVersion: string;
    clusterBodyAnchorFontId: string | null;
    baselinePageConsistencyState: Record<string, unknown> | null;
    preferredPeerFontId: string | null;
  }> = {},
) {
  return {
    policyVersion: "font-matching-page-relative-role-qa-v2",
    status,
    originalRole: "emphasis_dialogue",
    projectedRole: "emphasis_dialogue",
    preferredPeerFontId: null,
    reasonCodes: [],
    ...overrides,
  };
}

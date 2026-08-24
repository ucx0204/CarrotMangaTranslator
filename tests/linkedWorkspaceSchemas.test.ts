import { describe, expect, it } from "vitest";
import {
  ConnectLinkedWorkspaceRequestSchema,
  LinkedWorkspaceActivityRequestSchema,
  LinkedWorkspaceStatusSchema,
  UpdateLinkedWorkspaceRequestSchema,
} from "../src/shared/linkedWorkspaceSchemas";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";

const ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

describe("linked workspace IPC schemas", () => {
  it("accepts manual connect requests without renderer-supplied paths", () => {
    expect(
      ConnectLinkedWorkspaceRequestSchema.parse({
        workId: ID,
        chapterId: SECOND_ID,
        output: DEFAULT_RASTER_EXPORT_SETTINGS,
      }),
    ).toMatchObject({ workId: ID, chapterId: SECOND_ID });
  });

  it("requires an actual update and rejects unknown fields", () => {
    expect(
      UpdateLinkedWorkspaceRequestSchema.safeParse({ connectionId: ID })
        .success,
    ).toBe(false);
    expect(
      UpdateLinkedWorkspaceRequestSchema.safeParse({
        connectionId: ID,
        enabled: false,
        rootPath: "C:/untrusted",
      }).success,
    ).toBe(false);
  });

  it("validates activity boundaries and bounded status counts", () => {
    expect(
      LinkedWorkspaceActivityRequestSchema.parse({
        type: "start",
        interaction: "composition",
      }),
    ).toEqual({ type: "start", interaction: "composition" });
    expect(
      LinkedWorkspaceActivityRequestSchema.safeParse({
        type: "start",
        interaction: "keyboard",
      }).success,
    ).toBe(false);
    expect(
      LinkedWorkspaceStatusSchema.safeParse({
        chapterId: ID,
        state: "pending",
        pendingCount: -1,
        failedCount: 0,
      }).success,
    ).toBe(false);
  });
});

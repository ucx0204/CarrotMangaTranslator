import { describe, expect, it } from "vitest";
import {
  PageImageExportRequestSchema,
  PageImageExportPreflightRequestSchema,
  PagePsdExportRequestSchema,
  parseIpcPayload,
} from "../src/shared/ipcSchemas";
import { pageImageExportIpcContracts } from "../src/shared/ipcJobContracts";

describe("page image export schema", () => {
  it.each([5_000, 5_001])(
    "validates %i pages through preflight and raster/PSD export",
    (count) => {
      const chapterId = "22222222-2222-4222-8222-222222222222";
      const targets = Array.from({ length: count }, (_, index) => ({
        chapterId,
        pageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        revision: "page-v1:0123456789abcdef",
      }));
      const request = {
        workId: "11111111-1111-4111-8111-111111111111",
        selections: [{ chapterId, mode: "all" }],
        expectedTargets: targets,
      };
      const accepted = count === 5_000;
      for (const schema of [
        PageImageExportRequestSchema,
        PagePsdExportRequestSchema,
        PageImageExportPreflightRequestSchema,
      ]) {
        expect(schema.safeParse(request).success).toBe(accepted);
        expect(
          schema.safeParse({
            ...request,
            expectedTargets: undefined,
            selections: [
              {
                chapterId,
                mode: "page-set",
                pageIds: targets.map((target) => target.pageId),
              },
            ],
          }).success,
        ).toBe(accepted);
      }
      expect(
        PageImageExportPreflightRequestSchema.safeParse({
          ...request,
          outputFormat: "psd",
        }).success,
      ).toBe(accepted);
      const result = {
        workTitle: "Export",
        chapterCount: 1,
        pageCount: count,
        sampleRelativePath: "chapter/001.png",
        outputPolicy: "new-timestamped-folder",
        issues: [],
        targets,
      };
      expect(
        pageImageExportIpcContracts.preflightPageImages.result.safeParse(result)
          .success,
      ).toBe(accepted);
      expect(
        pageImageExportIpcContracts.preflightPageImages.result.safeParse({
          ...result,
          targets: [],
          issues: targets.flatMap((target) =>
            Array.from({ length: 4 }, () => ({
              code: "inpainted-image-missing",
              severity: "warning",
              chapterId,
              chapterTitle: "Chapter",
              pageId: target.pageId,
              pageName: "Page",
            })),
          ),
        }).success,
      ).toBe(accepted);
    },
  );

  it("accepts only a boolean textless page-export option", () => {
    const request = {
      workId: "11111111-1111-4111-8111-111111111111",
      selections: [
        {
          chapterId: "22222222-2222-4222-8222-222222222222",
          mode: "all" as const,
        },
      ],
      omitText: true,
    };
    expect(
      parseIpcPayload(PageImageExportRequestSchema, request, "PNG 출력")
        .omitText,
    ).toBe(true);
    expect(() =>
      parseIpcPayload(
        PageImageExportRequestSchema,
        { ...request, omitText: "yes" },
        "PNG 출력",
      ),
    ).toThrow(/요청 형식/);
  });

  it("keeps raster and PSD export schemas separate", () => {
    expect(
      PagePsdExportRequestSchema.parse({
        workId: "00000000-0000-4000-8000-000000000001",
        selections: [
          {
            chapterId: "00000000-0000-4000-8000-000000000002",
            mode: "all",
          },
        ],
      }).workId,
    ).toBe("00000000-0000-4000-8000-000000000001");
    expect(
      PageImageExportRequestSchema.safeParse({
        workId: "00000000-0000-4000-8000-000000000001",
        selections: [
          {
            chapterId: "00000000-0000-4000-8000-000000000002",
            mode: "all",
          },
        ],
        outputFormat: "psd",
      }).success,
    ).toBe(false);
    expect(
      PageImageExportRequestSchema.safeParse({
        workId: "00000000-0000-4000-8000-000000000001",
        selections: [
          {
            chapterId: "00000000-0000-4000-8000-000000000002",
            mode: "all",
          },
        ],
        outputFormat: "jpg",
      }).success,
    ).toBe(false);
  });
});

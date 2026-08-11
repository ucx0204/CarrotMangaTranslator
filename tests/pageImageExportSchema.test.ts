import { describe, expect, it } from "vitest";
import {
  PageImageExportRequestSchema,
  parseIpcPayload,
} from "../src/shared/ipcSchemas";

describe("page image export schema", () => {
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

  it("accepts PNG or PSD as the layered page-export format", () => {
    expect(
      PageImageExportRequestSchema.parse({
        workId: "00000000-0000-4000-8000-000000000001",
        selections: [
          {
            chapterId: "00000000-0000-4000-8000-000000000002",
            mode: "all",
          },
        ],
        outputFormat: "psd",
      }).outputFormat,
    ).toBe("psd");
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

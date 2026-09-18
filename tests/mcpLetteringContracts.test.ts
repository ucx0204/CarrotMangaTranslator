import { expect, it } from "vitest";
import { z } from "zod/v4";
import {
  McpLetteringAdvancedSchema,
  parseMcpLetteringRule,
} from "../src/shared/mcpLetteringAdvanced";
import { TranslationBlockObjectSchema } from "../src/shared/ipcSchemaPrimitives";
import {
  createCurvePreset,
  createPerspectivePreset,
} from "../src/shared/blockTransformPresets";
import {
  publicMcpJobResult,
  persistedMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import { McpLetteringPrepareSchema } from "../src/shared/mcpLettering";

it("matches native advanced-contract acceptance and never changes native normalization", () => {
  const examples = {
    textEffect: [
      {
        enabled: true,
        color: "#abcdef",
        offsetXpx: -2,
        offsetYpx: 3,
        blurPx: 64,
        opacity: 1,
      },
      {
        enabled: true,
        color: "invalid",
        offsetXpx: 0,
        offsetYpx: 0,
        blurPx: 4,
        opacity: 1,
      },
    ],
    textGlow: [
      { enabled: false, color: "#ffffff", blurPx: 0, opacity: 0 },
      { enabled: true, color: "#123456", blurPx: 65, opacity: 1 },
    ],
    perspectiveTransform: [
      createPerspectivePreset("skewLeft"),
      {
        version: 1,
        corners: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
      },
    ],
    curveLayout: [
      createCurvePreset("archDown"),
      { ...createCurvePreset("straight"), offsetEm: 99 },
    ],
    warpTransform: [
      { version: 1, gridSize: 3, points: [] },
      {
        version: 1,
        gridSize: 5,
        points: Array.from({ length: 16 }, () => ({ x: 0, y: 0 })),
      },
    ],
  };
  for (const [key, values] of Object.entries(examples)) {
    const native =
      TranslationBlockObjectSchema.shape[key as keyof typeof examples];
    for (const value of values)
      expect(
        McpLetteringAdvancedSchema.safeParse({ [key]: value }).success,
      ).toBe(native.safeParse(value).success);
    expect(McpLetteringAdvancedSchema.parse({ [key]: null })).toEqual({
      [key]: null,
    });
  }
  expect(z.toJSONSchema(McpLetteringAdvancedSchema).additionalProperties).toBe(
    false,
  );
});

it("expires references and strips all session history on durable receipt writes", () => {
  const result = {
    kind: "lettering-plan",
    pagesChanged: 0,
    letteringPlan: {
      batchId: "11111111-1111-4111-8111-111111111111",
      expiresAt: 2000,
    },
  };
  expect(publicMcpJobResult(result, 1999)?.letteringPlan).toBeDefined();
  expect(publicMcpJobResult(result, 2000)).toEqual({
    kind: "lettering-plan",
    pagesChanged: 0,
    proposalExpired: true,
  });
  expect(persistedMcpJobResult(result)).toEqual({
    kind: "lettering-plan",
    pagesChanged: 0,
    proposalExpired: true,
  });
});

it("does not advertise an unimplemented resource command or accept invalid native rule JSON", () => {
  const schema = z.toJSONSchema(McpLetteringPrepareSchema);
  expect(JSON.stringify(schema)).not.toContain("resourceKind");
  expect(() => parseMcpLetteringRule("not JSON")).toThrow();
  expect(() => parseMcpLetteringRule("[]")).toThrow();
  expect(() =>
    McpLetteringAdvancedSchema.parse({
      textGlow: {
        enabled: true,
        color: "#ffffff",
        blurPx: 1,
        opacity: 1,
        path: "private",
      },
    }),
  ).toThrow();
});

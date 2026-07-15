import { describe, expect, it } from "vitest";
import {
  createCurvePreset,
  createPerspectivePreset,
  CURVE_PRESETS,
  isValidPerspectiveTransform,
  mapPointToQuad,
  mapPointWithMatrix3d,
  matrix3dToCss,
  normalizeCurveLayout,
  normalizePerspectiveTransform,
  PERSPECTIVE_PRESETS,
  quadraticLength,
  quadraticPathToSvg,
  quadraticPointAt,
  quadraticTangentAt,
  rectToQuadMatrix3d,
  validatePerspectiveCorners,
  validateQuadraticPath,
} from "../src/shared/blockTransforms";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import type { PerspectiveTransform, Point } from "../src/shared/textTypes";

describe("block transform presets and safety", () => {
  it("provides identity plus six safe, independently editable perspective presets", () => {
    expect(Object.keys(PERSPECTIVE_PRESETS)).toEqual([
      "identity",
      "topNarrow",
      "bottomNarrow",
      "leftNarrow",
      "rightNarrow",
      "skewLeft",
      "skewRight",
    ]);

    for (const name of Object.keys(PERSPECTIVE_PRESETS) as Array<
      keyof typeof PERSPECTIVE_PRESETS
    >) {
      expect(isValidPerspectiveTransform(createPerspectivePreset(name))).toBe(
        true,
      );
    }

    const editable = createPerspectivePreset("identity");
    editable.corners[0].x = 0.25;
    expect(createPerspectivePreset("identity").corners[0].x).toBe(0);
  });

  it("rejects crossing, collapsed, short-edged, concave, and flipped quads", () => {
    expect(
      validatePerspectiveCorners([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]).reason,
    ).toBe("self-intersection");
    expect(
      validatePerspectiveCorners([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.001 },
        { x: 0, y: 0.001 },
      ]).reason,
    ).toBe("edge-too-short");
    expect(
      validatePerspectiveCorners([
        { x: 0, y: 0 },
        { x: 0.01, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]).reason,
    ).toBe("edge-too-short");
    expect(
      validatePerspectiveCorners([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.35, y: 0.35 },
        { x: 0, y: 1 },
      ]).reason,
    ).toBe("concave");
    expect(
      validatePerspectiveCorners([
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
      ]).reason,
    ).toBe("flipped");
  });

  it("normalizes precision while falling back to identity for unsafe data", () => {
    expect(
      normalizePerspectiveTransform({
        version: 1,
        corners: [
          { x: 0.00000049, y: 0 },
          { x: 1.00000049, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      }).corners,
    ).toEqual(PERSPECTIVE_PRESETS.identity.corners);

    const crossing: PerspectiveTransform = {
      version: 1,
      corners: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    };
    expect(normalizePerspectiveTransform(crossing)).toEqual(
      createPerspectivePreset("identity"),
    );
  });

  it("provides straight and two arch curve presets without shared mutations", () => {
    expect(Object.keys(CURVE_PRESETS)).toEqual([
      "straight",
      "archUp",
      "archDown",
    ]);
    for (const name of Object.keys(CURVE_PRESETS) as Array<
      keyof typeof CURVE_PRESETS
    >) {
      expect(validateQuadraticPath(createCurvePreset(name).path).valid).toBe(
        true,
      );
    }

    const editable = createCurvePreset("archUp");
    editable.path.control.y = 0;
    expect(createCurvePreset("archUp").path.control.y).toBe(-0.25);
  });

  it("normalizes curve options and replaces unusably short paths", () => {
    const normalized = normalizeCurveLayout({
      ...createCurvePreset("archUp"),
      offsetEm: 50,
      reversed: true,
      fitSpacing: false,
    });
    expect(normalized.offsetEm).toBe(12);
    expect(normalized.reversed).toBe(true);
    expect(normalized).not.toHaveProperty("fitSpacing");

    expect(
      normalizeCurveLayout({
        ...createCurvePreset("straight"),
        path: {
          type: "quadratic",
          start: { x: 0.5, y: 0.5 },
          control: { x: 0.501, y: 0.5 },
          end: { x: 0.502, y: 0.5 },
        },
      }),
    ).toEqual(createCurvePreset("straight"));
  });
});

describe("quadratic curve math", () => {
  it("evaluates points, unit tangents, length, and an SVG path", () => {
    const path = createCurvePreset("archUp").path;
    expect(quadraticPointAt(path, 0)).toEqual(path.start);
    expect(quadraticPointAt(path, 1)).toEqual(path.end);
    expect(quadraticPointAt(path, 0.5)).toEqual({ x: 0.5, y: 0.125 });

    const tangent = quadraticTangentAt(path, 0.5);
    expect(tangent.x).toBeCloseTo(1, 8);
    expect(tangent.y).toBeCloseTo(0, 8);
    expect(Math.hypot(tangent.x, tangent.y)).toBeCloseTo(1, 8);
    expect(quadraticLength(path)).toBeGreaterThan(1);
    expect(quadraticLength(createCurvePreset("straight").path)).toBeCloseTo(
      1,
      8,
    );
    expect(quadraticPathToSvg(path)).toBe("M 0 0.5 Q 0.5 -0.25 1 0.5");
  });

  it("clamps out-of-range t values to the path endpoints", () => {
    const path = createCurvePreset("straight").path;
    expect(quadraticPointAt(path, -10)).toEqual(path.start);
    expect(quadraticPointAt(path, 10)).toEqual(path.end);
  });
});

describe("quad mapping and CSS matrix3d", () => {
  it("maps every source corner to its target on a non-square rectangle", () => {
    const transform = createPerspectivePreset("topNarrow");
    const matrix = rectToQuadMatrix3d(200, 100, transform.corners);
    const sourceCorners: Point[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];

    sourceCorners.forEach((source, index) => {
      const mapped = mapPointWithMatrix3d(source, matrix);
      expect(mapped.x).toBeCloseTo(transform.corners[index].x * 200, 8);
      expect(mapped.y).toBeCloseTo(transform.corners[index].y * 100, 8);
    });
  });

  it("keeps normalized point mapping consistent with the CSS matrix", () => {
    const transform = createPerspectivePreset("rightNarrow");
    const normalizedPoint = { x: 0.37, y: 0.62 };
    const normalizedMapped = mapPointToQuad(normalizedPoint, transform.corners);
    const matrixMapped = mapPointWithMatrix3d(
      { x: normalizedPoint.x * 320, y: normalizedPoint.y * 90 },
      rectToQuadMatrix3d(320, 90, transform.corners),
    );

    expect(matrixMapped.x / 320).toBeCloseTo(normalizedMapped.x, 8);
    expect(matrixMapped.y / 90).toBeCloseTo(normalizedMapped.y, 8);
    expect(matrix3dToCss(rectToQuadMatrix3d(1, 1, transform.corners))).toMatch(
      /^matrix3d\(.+\)$/,
    );
  });

  it("rejects invalid source sizes and unsafe quads", () => {
    expect(() =>
      rectToQuadMatrix3d(0, 100, createPerspectivePreset("identity").corners),
    ).toThrow(/positive size/);
    expect(() =>
      mapPointToQuad({ x: 0.5, y: 0.5 }, [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    ).toThrow(/unsafe quad/);
  });
});

describe("translation block transform IPC compatibility", () => {
  const baseBlock = {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 10, y: 10, w: 100, h: 100 },
    sourceText: "原文",
    translatedText: "효과음",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.8,
  };

  it("keeps legacy blocks valid and accepts safe optional transforms", () => {
    expect(TranslationBlockSchema.safeParse(baseBlock).success).toBe(true);
    expect(
      TranslationBlockSchema.safeParse({
        ...baseBlock,
        rotationDeg: 180,
        perspectiveTransform: createPerspectivePreset("topNarrow"),
        curveLayout: createCurvePreset("archUp"),
      }).success,
    ).toBe(true);
  });

  it("rejects non-canonical rotation and unsafe saved transforms", () => {
    expect(
      TranslationBlockSchema.safeParse({ ...baseBlock, rotationDeg: 180.1 })
        .success,
    ).toBe(false);
    expect(
      TranslationBlockSchema.safeParse({
        ...baseBlock,
        perspectiveTransform: {
          version: 1,
          corners: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

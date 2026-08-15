// @ts-check

function createFixtureBlocks() {
  return [
    createBlock("rich", {
      bbox: { x: 110.25, y: 75.5, w: 300.5, h: 155.25 },
      bold: true,
      fontWidthScale: 0.86,
      italic: true,
      letterSpacing: 0.08,
      rotationDeg: 13.5,
      translatedText: "**굵게** 그리고 *기울임*",
    }),
    createBlock("vertical", {
      bbox: { x: 650.2, y: 105.4, w: 155.7, h: 350.3 },
      renderDirection: "vertical",
      translatedText: "세로쓰기",
      warpTransform: createWarpFixture("wave", 3),
      wordBreak: "keep-all",
    }),
    createBlock("perspective", {
      bbox: { x: 145.1, y: 495.6, w: 600.8, h: 135.2 },
      perspectiveTransform: {
        corners: [
          { x: 0.04, y: 0.1 },
          { x: 0.98, y: 0 },
          { x: 0.91, y: 0.94 },
          { x: 0.02, y: 0.82 },
        ],
        version: 1,
      },
      translatedText: "원근 변환",
      warpTransform: createWarpFixture("bulge", 3),
    }),
    createBlock("curve", {
      bbox: { x: 115.5, y: 730.25, w: 710.5, h: 190.75 },
      curveLayout: {
        alignment: "center",
        fitSpacing: true,
        offsetEm: 0.15,
        orientation: "tangent",
        path: {
          control: { x: 0.5, y: 0.05 },
          end: { x: 0.95, y: 0.7 },
          start: { x: 0.05, y: 0.7 },
          type: "quadratic",
        },
        version: 1,
      },
      perspectiveTransform: {
        corners: [
          { x: 0.03, y: 0.04 },
          { x: 0.96, y: 0 },
          { x: 1, y: 0.94 },
          { x: 0.02, y: 1 },
        ],
        version: 1,
      },
      rotationDeg: -4.5,
      translatedText: "곡선 텍스트",
      warpTransform: createWarpFixture("archUp", 5),
    }),
    createBlock("multiline-warp", {
      bbox: { x: 355, y: 955, w: 520, h: 150 },
      bold: true,
      italic: true,
      translatedText: "**여러 줄**과 *부분 강조*\n외곽선도 함께",
      warpTransform: createWarpFixture("flag", 3),
    }),
    createBlock("empty", {
      bbox: { x: 90, y: 980, w: 240, h: 90 },
      sourceText: "",
      translatedText: "",
    }),
  ];
}

/**
 * @param {"archUp" | "bulge" | "flag" | "wave"} name
 * @param {3 | 5} gridSize
 */
function createWarpFixture(name, gridSize) {
  const side = gridSize + 1;
  return {
    version: 1,
    gridSize,
    points: Array.from({ length: side * side }, (_value, index) => {
      const point = {
        x: (index % side) / gridSize,
        y: Math.floor(index / side) / gridSize,
      };
      const centeredX = point.x - 0.5;
      const centeredY = point.y - 0.5;
      const horizontalEnvelope = Math.sin(Math.PI * point.x);
      const verticalEnvelope = Math.sin(Math.PI * point.y);
      if (name === "archUp") {
        return { x: point.x, y: point.y - 0.22 * horizontalEnvelope };
      }
      if (name === "bulge") {
        const scale = 1 + 0.24 * horizontalEnvelope * verticalEnvelope;
        return { x: 0.5 + centeredX * scale, y: 0.5 + centeredY * scale };
      }
      if (name === "flag") {
        return {
          x: point.x,
          y:
            point.y +
            0.13 * Math.sin(Math.PI * 2 * point.x) * (0.72 + point.y * 0.28),
        };
      }
      return {
        x:
          point.x +
          0.035 * Math.sin(Math.PI * 2 * point.y) * horizontalEnvelope,
        y: point.y + 0.12 * Math.sin(Math.PI * 2 * point.x),
      };
    }),
  };
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} overrides
 */
function createBlock(id, overrides) {
  return {
    autoFitText: true,
    backgroundColor: "#ffffff",
    bbox: { x: 100, y: 100, w: 300, h: 160 },
    confidence: 1,
    fontFamily: "nanum-myeongjo",
    fontSizePx: 34,
    id,
    lineHeight: 1.18,
    opacity: 1,
    outlineColor: "#ffffff",
    outlineWidthScale: 0.04,
    renderDirection: "horizontal",
    sourceDirection: "horizontal",
    sourceText: "",
    textAlign: "center",
    textColor: "#111111",
    translatedText: "텍스트",
    type: "nonsolid",
    ...overrides,
  };
}

module.exports = { createFixtureBlocks };

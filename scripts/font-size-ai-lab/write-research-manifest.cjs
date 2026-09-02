#!/usr/bin/env node
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated experiment/audit utility; production types remain checked.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const initialQueries = [
  "site:arxiv.org Japanese vertical text detection ruby annotation OCR projection profile",
  "site:arxiv.org manga text detection speech bubble segmentation OCR",
  "site:openaccess.thecvf.com scene text detection post processing connected components segmentation",
  "site:aclanthology.org Japanese OCR vertical text layout ruby",
];

const topics = [
  "Japanese vertical text line segmentation",
  "ruby furigana annotation detection removal OCR",
  "projection profile character font size estimation",
  "connected component character grouping document images",
  "manga text detection segmentation",
  "speech balloon segmentation text association comics",
  "manga panel segmentation reading order",
  "instance segmentation duplicate mask suppression text",
  "robust quantile bounding box segmentation mask outliers",
  "graph clustering connected components text lines",
  "arbitrary shape scene text detection",
  "progressive text kernel expansion segmentation",
  "differentiable binarization text detection DBNet",
  "character region affinity text detection CRAFT",
  "progressive scale expansion network PSENet text",
  "pixel aggregation network PAN text detection",
  "TextSnake text geometry representation",
  "Mask TextSpotter instance segmentation",
  "Japanese document OCR layout analysis vertical writing",
  "document image orientation skew vertical text",
  "raster typography cap height glyph size estimation",
  "robust statistics trimmed quantiles median absolute deviation image",
  "stroke width transform text component grouping",
  "OCR page hierarchy region line word segmentation",
  "weakly supervised comic manga text localization",
  "Manga109 dialogue balloon annotation dataset",
  "Japanese manga reading order graph",
  "text border repulsion instance separation scene text",
];

const focuses = [
  "site:arxiv.org primary research paper",
  "site:openaccess.thecvf.com paper method",
  "loss ablation postprocessing research",
  "official author GitHub implementation paper",
  "dataset benchmark evaluation paper",
  "failure cases tiny small text paper",
  "vertical Japanese application study",
];

const matrixQueries = topics.flatMap((topic) =>
  focuses.map((focus) => `${topic} ${focus}`),
);
const queries = [...initialQueries, ...matrixQueries];
if (queries.length !== 200 || new Set(queries).size !== 200) {
  throw new Error(
    `Expected 200 unique queries, got ${queries.length}/${new Set(queries).size}.`,
  );
}

const output = path.resolve(
  process.argv[2] ??
    "artifacts/font-size-ai-lab/research-2026-09-02/query-manifest.json",
);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      execution: {
        searchQueryCount: 200,
        uniqueQueryCount: 200,
        webBatchCount: 50,
        storedMatrixBatchCount: 49,
        rawUrlMentions: 1231,
        uniqueResultUrls: 930,
      },
      generation: {
        initialQueryCount: initialQueries.length,
        topicCount: topics.length,
        focusCount: focuses.length,
      },
      queries,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(JSON.stringify({ output, queryCount: queries.length }, null, 2));

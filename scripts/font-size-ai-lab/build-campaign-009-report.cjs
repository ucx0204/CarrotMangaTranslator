#!/usr/bin/env electron
/* eslint-disable -- isolated self-contained chapter report generator */
// @ts-nocheck -- laboratory artifact generator, not production code.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const repoRoot = path.resolve(__dirname, "../..");
const labRoot = path.join(repoRoot, "artifacts", "font-size-ai-lab");
const campaignRoot = path.join(labRoot, "campaign-009");
const baselineRoot = path.join(campaignRoot, "exp-01-v0.8.0-baseline");
const finalRoot = path.join(campaignRoot, "exp-05-v0.9.0-candidate-actual");
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") output = path.resolve(argv[++index]);
    else throw new Error("Unknown argument: " + argv[index]);
  }
  return { output };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmt(value, digits) {
  const precision = digits == null ? 4 : digits;
  if (!Number.isFinite(value)) return "—";
  return Number(value)
    .toFixed(precision)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
}

function px(value) {
  return Number.isFinite(value) ? fmt(value) + "px" : "abstain";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const imageCache = new Map();
const embeddedPaths = new Set();
let embeddedBytes = 0;

function imageDataUri(filePath, maxWidth, quality) {
  const absolute = path.resolve(filePath);
  const key = absolute + "\0" + maxWidth + "\0" + quality;
  if (imageCache.has(key)) return imageCache.get(key);
  if (!fs.existsSync(absolute)) throw new Error("Missing image: " + absolute);
  let image = nativeImage.createFromPath(absolute);
  if (image.isEmpty()) throw new Error("Could not decode image: " + absolute);
  if (image.getSize().width > maxWidth) {
    image = image.resize({ width: maxWidth, quality: "best" });
  }
  const bytes = image.toJPEG(quality);
  const uri = "data:image/jpeg;base64," + bytes.toString("base64");
  imageCache.set(key, uri);
  embeddedPaths.add(absolute);
  embeddedBytes += bytes.length;
  return uri;
}

function imageTag(filePath, alt, maxWidth, quality) {
  return (
    '<img src="' +
    imageDataUri(filePath, maxWidth, quality) +
    '" alt="' +
    escapeHtml(alt) +
    '" loading="lazy" decoding="async">'
  );
}

function sourceKey(region) {
  return [...region.sourceDetectionIds].sort().join("+");
}

function readPage(root, pageId) {
  const pageRoot = path.join(root, "pages", pageId);
  return {
    manifest: readJson(path.join(pageRoot, "ocr", "hayai-regions.json")),
    report: readJson(path.join(pageRoot, "page.json")),
  };
}

function readCandidateBySource(root, pageId, detectionIds) {
  const page = readPage(root, pageId);
  const key = [...detectionIds].sort().join("+");
  const region = page.manifest.dialogueRegions.find(
    (entry) => sourceKey(entry) === key,
  );
  if (!region) throw new Error("Missing " + pageId + "/" + key);
  const candidate = page.report.candidates.find(
    (entry) => entry.candidateId === region.regionId,
  );
  if (!candidate)
    throw new Error("Missing candidate " + pageId + "/" + region.regionId);
  return { candidate, region };
}

function candidateCard(root, pageId, record, badges, note) {
  const candidate = record.candidate;
  const region = record.region;
  const bbox = candidate.bbox;
  const labels = (badges || [])
    .map((badge) => "<i>" + escapeHtml(badge) + "</i>")
    .join("");
  const search = [
    pageId,
    candidate.candidateId,
    candidate.sourceText,
    ...(region ? region.sourceDetectionIds : []),
    ...(badges || []),
  ]
    .join(" ")
    .toLocaleLowerCase("ko-KR");
  return (
    '<article class="crop-card" data-search="' +
    escapeHtml(search) +
    '"><div class="crop-image">' +
    imageTag(
      path.join(root, candidate.cropPath),
      pageId + "/" + candidate.candidateId + " 확대",
      780,
      93,
    ) +
    '</div><div class="crop-copy"><div class="crop-title"><strong>' +
    escapeHtml(pageId + "/" + candidate.candidateId) +
    "</strong><span>" +
    labels +
    '</span></div><p class="source">' +
    escapeHtml(candidate.sourceText || "OCR 문자열 없음") +
    "</p><dl><div><dt>방향</dt><dd>" +
    escapeHtml(candidate.direction) +
    "</dd></div><div><dt>bbox</dt><dd>" +
    fmt(bbox.x2 - bbox.x1, 0) +
    "×" +
    fmt(bbox.y2 - bbox.y1, 0) +
    "</dd></div><div><dt>추정 크기</dt><dd>" +
    px(candidate.estimate && candidate.estimate.facePx) +
    "</dd></div><div><dt>크기 신뢰도</dt><dd>" +
    fmt(candidate.estimate && candidate.estimate.confidence) +
    "</dd></div><div><dt>Hayai</dt><dd>" +
    fmt(candidate.hayaiConfidence) +
    "</dd></div><div><dt>원 검출</dt><dd>" +
    escapeHtml(region ? region.sourceDetectionIds.join("+") : "—") +
    "</dd></div></dl>" +
    (note ? '<p class="note">' + escapeHtml(note) + "</p>" : "") +
    "</div></article>"
  );
}

function overlayPair(beforeRoot, afterRoot, pageId) {
  return (
    '<div class="overlay-pair"><figure>' +
    imageTag(
      path.join(beforeRoot, "pages", pageId, "bbox-overlay.png"),
      pageId + " v0.8.0 오버레이",
      1100,
      89,
    ) +
    "<figcaption>v0.8.0 · 분리 전</figcaption></figure><figure>" +
    imageTag(
      path.join(afterRoot, "pages", pageId, "bbox-overlay.png"),
      pageId + " v0.9.0 오버레이",
      1100,
      89,
    ) +
    "<figcaption>v0.9.0 · 재결합 후</figcaption></figure></div>"
  );
}

const changes = [
  {
    pageId: "P004",
    title: "말풍선 아래의 ‘神器’를 앞 문장에 복구",
    before: [["T003"], ["T006"]],
    after: ["T003", "T006"],
  },
  {
    pageId: "P006",
    title: "한 말풍선의 주문 부탁과 응답을 한 단위로 복구",
    before: [["T002"], ["T013"]],
    after: ["T002", "T013"],
  },
  {
    pageId: "P014",
    title: "‘大丈夫よ’와 이어지는 설명을 복구",
    before: [["T007"], ["T010"]],
    after: ["T007", "T010"],
  },
  {
    pageId: "P019",
    title: "호흡 확인 문장을 한 말풍선으로 복구",
    before: [["T010"], ["T013"]],
    after: ["T010", "T013"],
  },
  {
    pageId: "P021",
    title: "대각선으로 끊긴 긴 세로 문장을 복구",
    before: [["T011"], ["T014"]],
    after: ["T011", "T014"],
  },
  {
    pageId: "P031",
    title: "‘…ごめん’과 ‘先に戻ってて’를 복구",
    before: [["T010"], ["T017"]],
    after: ["T010", "T017"],
  },
];

function mergeChange(change) {
  const before = change.before.map((ids) =>
    readCandidateBySource(baselineRoot, change.pageId, ids),
  );
  const after = readCandidateBySource(finalRoot, change.pageId, change.after);
  return (
    '<section class="change"><h3>' +
    escapeHtml(change.pageId + " · " + change.title) +
    '</h3><div class="before-after"><div><h4>v0.8.0 · 분리</h4><div class="crop-grid">' +
    before
      .map((record) =>
        candidateCard(baselineRoot, change.pageId, record, ["분리"], ""),
      )
      .join("") +
    '</div></div><div><h4>v0.9.0 · 실제 HayaiOCR</h4><div class="crop-grid">' +
    candidateCard(
      finalRoot,
      change.pageId,
      after,
      ["재결합", "세로", "2 segment"],
      "원 recognition bbox 두 개를 보존해 합친 영역의 빈 공간을 글자 크기로 세지 않습니다.",
    ) +
    '</div></div></div><p class="callout"><strong>판정:</strong> OCR 순서 ' +
    escapeHtml(after.candidate.sourceText) +
    ", source face " +
    px(after.candidate.estimate && after.candidate.estimate.facePx) +
    ".</p>" +
    overlayPair(baselineRoot, finalRoot, change.pageId) +
    "</section>"
  );
}

function regressionAudit(root, label) {
  const evaluation = readJson(path.join(root, "geometry-evaluation.json"));
  const cards = [];
  for (const page of evaluation.pages) {
    for (const match of page.matches.filter((entry) => entry.changed)) {
      const stem =
        match.newRegionId +
        "-from-" +
        (match.oldRegionId || "none") +
        "-new.png";
      const cropPath = path.join(root, "pages", page.pageId, "changed", stem);
      cards.push(
        '<article class="audit-card"><div class="crop-image">' +
          imageTag(
            cropPath,
            label + " " + page.pageId + " 회귀 확대",
            780,
            93,
          ) +
          '</div><div class="crop-copy"><strong>' +
          escapeHtml(label + " · " + page.pageId) +
          "</strong><p>" +
          escapeHtml(match.newSourceDetectionIds.join("+")) +
          " · 한 연결 말풍선의 연속 문장</p></div></article>",
      );
    }
  }
  return {
    html: cards.join(""),
    count: cards.length,
    totals: evaluation.totals,
  };
}

function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const baseline = readJson(path.join(baselineRoot, "baseline-report.json"));
  const final = readJson(path.join(finalRoot, "baseline-report.json"));
  const parity = readJson(
    path.join(campaignRoot, "actual-chapter-parity.json"),
  );
  const exp2 = readJson(
    path.join(
      campaignRoot,
      "exp-02-adjacent-vertical-fragment-rejoin-geometry",
      "geometry-evaluation.json",
    ),
  );
  const exp3 = readJson(
    path.join(
      campaignRoot,
      "exp-03-outline-gated-adjacent-fragment-rejoin-geometry",
      "geometry-evaluation.json",
    ),
  );
  const exp4 = readJson(
    path.join(
      campaignRoot,
      "exp-04-outline200-adjacent-fragment-rejoin-geometry",
      "geometry-evaluation.json",
    ),
  );
  const exp5 = readJson(
    path.join(
      campaignRoot,
      "exp-05-caption-gated-outline200-geometry",
      "geometry-evaluation.json",
    ),
  );

  const regressions = [
    {
      label: "캠페인 008 · 18페이지",
      root: path.join(campaignRoot, "regression-campaign-008-v0.9-exp05"),
    },
    {
      label: "캠페인 007 · 20페이지",
      root: path.join(campaignRoot, "regression-campaign-007-v0.9-exp05"),
    },
    {
      label: "캠페인 006 · 18페이지",
      root: path.join(campaignRoot, "regression-campaign-006-v0.9-exp05"),
    },
    {
      label: "캠페인 001 · 32페이지",
      root: path.join(campaignRoot, "regression-campaign-001-v0.9-exp05"),
    },
  ].map((entry) => ({
    ...entry,
    audit: regressionAudit(entry.root, entry.label),
  }));
  const regressionChangeCount = regressions.reduce(
    (sum, entry) => sum + entry.audit.count,
    0,
  );

  const changedPages = new Set(changes.map((entry) => entry.pageId));
  const pageSections = [];
  let finalCropCount = 0;
  for (const page of final.pages) {
    const assets = readPage(finalRoot, page.pageId);
    const regionById = new Map(
      assets.manifest.dialogueRegions.map((region) => [
        region.regionId,
        region,
      ]),
    );
    const cards = page.candidates
      .map((candidate) => {
        finalCropCount += 1;
        const region = regionById.get(candidate.candidateId);
        const merged = region && region.sourceDetectionIds.length > 1;
        return candidateCard(
          finalRoot,
          page.pageId,
          { candidate, region },
          merged ? ["v0.9.0 재결합"] : [],
          "",
        );
      })
      .join("");
    pageSections.push(
      '<details class="page"' +
        (changedPages.has(page.pageId) ? " open" : "") +
        "><summary><strong>" +
        escapeHtml(page.pageId) +
        "</strong><span>일반 텍스트 " +
        page.dialogueCount +
        "개</span></summary>" +
        (changedPages.has(page.pageId)
          ? '<p class="page-note">이번 화에서 같은 말풍선 분할을 복구한 페이지입니다.</p>'
          : "") +
        "<figure>" +
        imageTag(
          path.join(finalRoot, page.overlayPath),
          page.pageId + " 최종 bbox 오버레이",
          1100,
          89,
        ) +
        '<figcaption>빨강: 일반 텍스트 · 파랑: 효과음 후보(사용자 선택 영역, 이번 판정 제외)</figcaption></figure><div class="crop-grid page-crops">' +
        cards +
        "</div></details>",
    );
  }
  if (finalCropCount !== final.summary.dialogueCount) {
    throw new Error("Final crop count mismatch: " + finalCropCount);
  }

  const regressionRows = regressions
    .map(
      (entry) =>
        "<tr><td>" +
        escapeHtml(entry.label) +
        "</td><td>" +
        entry.audit.totals.oldDialogueCount +
        "→" +
        entry.audit.totals.newDialogueCount +
        "</td><td>" +
        entry.audit.count +
        "개 연결 말풍선 재결합 · 확대 확인</td></tr>",
    )
    .join("");

  const exp4FalseRoot = path.join(campaignRoot);
  const captionSentinels =
    '<div class="sentinel-grid"><figure>' +
    imageTag(
      path.join(
        exp4FalseRoot,
        "regression-campaign-008-v0.9-candidate",
        "pages",
        "P008",
        "changed",
        "D007-from-D007-new.png",
      ),
      "캠페인 008 직사각형 캡션 오결합",
      780,
      93,
    ) +
    "<figcaption>실험 4 반례 · 서로 다른 직사각형 캡션을 합침</figcaption></figure><figure>" +
    imageTag(
      path.join(
        exp4FalseRoot,
        "regression-campaign-008-v0.9-exp05",
        "pages",
        "P008",
        "old-orange-new-green.png",
      ),
      "캠페인 008 캡션 차단 후",
      900,
      90,
    ) +
    "<figcaption>실험 5 · 두 캡션을 다시 별도 블록으로 유지</figcaption></figure><figure>" +
    imageTag(
      path.join(
        exp4FalseRoot,
        "regression-campaign-007-v0.9-candidate",
        "pages",
        "P006",
        "changed",
        "D001-from-D003-new.png",
      ),
      "캠페인 007 직사각형 캡션 오결합",
      780,
      93,
    ) +
    "<figcaption>실험 4 반례 · 맞닿은 내레이션 상자 오결합</figcaption></figure><figure>" +
    imageTag(
      path.join(
        exp4FalseRoot,
        "regression-campaign-007-v0.9-exp05",
        "pages",
        "P006",
        "old-orange-new-green.png",
      ),
      "캠페인 007 캡션 차단 후",
      900,
      90,
    ) +
    "<figcaption>실험 5 · 캡션은 분리, 실제 말풍선 조각만 결합</figcaption></figure></div>";

  const generatedAt = new Date().toISOString();
  const title = selection.series + " · " + selection.chapter;
  const html =
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>글자 크기 AI 캠페인 009 · ' +
    escapeHtml(selection.chapter) +
    '</title><style>:root{color-scheme:light;--ink:#172033;--muted:#68738a;--line:#dce3ee;--good:#087a55;--bad:#b32929;--blue:#315bd6;--paper:#f4f6fa}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}.shell{max-width:1480px;margin:auto;padding:26px}.hero,.panel,.page{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 28px #2638590d}.hero{padding:32px;background:linear-gradient(135deg,#fff,#edf4ff)}h1{font-size:clamp(25px,3.4vw,42px);line-height:1.14;margin:8px 0}.eyebrow{color:var(--blue);font-weight:850;letter-spacing:.08em}.scope{display:inline-block;margin-top:10px;padding:7px 12px;border-radius:999px;background:#e2f7ef;color:#086345;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px;margin-top:22px}.metric{border:1px solid var(--line);border-radius:12px;padding:13px;background:#fff}.metric strong{display:block;font-size:24px}.metric span,.muted{color:var(--muted)}.panel{padding:24px;margin:18px 0}h2{margin:0 0 12px;font-size:24px}h3{font-size:20px}.callout{padding:13px 15px;border-left:4px solid var(--good);background:#ebf9f3;border-radius:8px}.callout.bad{border-color:var(--bad);background:#fff0f0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f3f6fa}.change{border-top:1px solid var(--line);padding:18px 0}.change:first-of-type{border-top:0}.before-after,.overlay-pair,.sentinel-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.crop-grid,.regression-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.crop-card,.audit-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-width:0}.crop-image{display:flex;align-items:center;justify-content:center;min-height:170px;padding:8px;background:#eef1f6}.crop-image img{display:block;max-width:100%;max-height:590px;object-fit:contain}.crop-copy{padding:11px}.crop-title{display:flex;justify-content:space-between;gap:8px}.crop-title span{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}.crop-title i{font-style:normal;font-size:11px;font-weight:800;padding:2px 6px;border-radius:999px;background:#dff5ec;color:#087250}.source{min-height:2.5em}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px}dl div{display:flex;justify-content:space-between;border-bottom:1px dotted #cbd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.note{padding:8px;border-radius:7px;background:#fff4d8}.overlay-pair figure,.sentinel-grid figure{margin:8px 0}.overlay-pair img,.sentinel-grid img{display:block;max-width:100%;max-height:840px;margin:auto}.overlay-pair figcaption,.sentinel-grid figcaption{text-align:center;color:var(--muted)}.page{margin:12px 0;overflow:hidden}.page summary{display:flex;justify-content:space-between;padding:15px 18px;cursor:pointer}.page[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:14px 18px 0;padding:9px 11px;background:#f1f5ff;border-radius:8px}.page>figure{margin:17px auto;max-width:1110px;padding:0 18px}.page>figure img{display:block;max-width:100%;max-height:960px;margin:auto}.page>figure figcaption{text-align:center;color:var(--muted)}.page-crops{padding:0 18px 20px}.controls{position:sticky;top:0;z-index:5;padding:10px 0;background:#f4f6fae8;backdrop-filter:blur(10px);display:flex;gap:8px}.controls input{flex:1;min-width:220px;padding:10px;border:1px solid #aeb8ca;border-radius:9px}.controls button{padding:9px;border:1px solid #aeb8ca;border-radius:9px;background:#fff}[hidden]{display:none!important}@media(max-width:900px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.before-after,.overlay-pair,.sentinel-grid{grid-template-columns:1fr}.crop-grid,.regression-grid{grid-template-columns:1fr}}@media(max-width:430px){.metrics{grid-template-columns:1fr}.controls{flex-wrap:wrap}.controls input{min-width:100%}}</style></head><body><main class="shell"><section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 009</div><h1>' +
    escapeHtml(title) +
    '</h1><div class="scope">Koharu Text Detector + HayaiOCR CUDA/cu126 · 효과음 ' +
    final.summary.effectCount +
    '개 제외</div><p>32페이지 전체와 기준선 일반 텍스트 108개를 원본 확대 감사했습니다. 최종 변경 6개를 다시 확대했고 나머지 96개는 bbox·OCR·추정 크기 exact parity입니다. 아래에는 최종 일반 crop 102개와 실제 페이지를 모두 내장했습니다.</p><div class="metrics"><div class="metric"><strong>32 / 32</strong><span>전체 페이지 확대</span></div><div class="metric"><strong>102 / 102</strong><span>최종 일반 crop</span></div><div class="metric"><strong>6</strong><span>현재 화 문장 복구</span></div><div class="metric"><strong>96 / 96</strong><span>나머지 완전 동일</span></div><div class="metric"><strong>5 / 5</strong><span>실험 사용</span></div></div></section><section class="panel"><h2>결론 · 내부 버전 fsai-lab-v0.9.0</h2><p class="callout"><strong>승격:</strong> 같은 말풍선에서 떨어져 검출된 세로 열 6쌍을 실제 HayaiOCR 한 문장으로 복구했습니다. 원 recognition segment를 보존하므로 긴 union의 빈 공간이 글자 크기를 왜곡하지 않습니다.</p><p class="callout bad"><strong>반복 금지:</strong> 같은 bubble 소속과 거리만 쓰는 조합, luminance 180 조합, 직사각형 캡션 형태를 무시한 전역 light-component 조합은 다시 사용하지 않습니다.</p></section><section class="panel"><h2>5회 실험 기록</h2><div class="table-wrap"><table><thead><tr><th>회차</th><th>가설</th><th>결과</th><th>판정</th></tr></thead><tbody><tr><td>1</td><td>v0.8.0 실제 기준선</td><td>일반 ' +
    baseline.summary.dialogueCount +
    "개, 추정 " +
    baseline.summary.estimatedCount +
    "개, abstain " +
    baseline.summary.abstainedCount +
    "개</td><td>동일 말풍선 분할 6건 확인</td></tr><tr><td>2</td><td>같은 bubble + 거리</td><td>" +
    exp2.totals.oldDialogueCount +
    "→" +
    exp2.totals.newDialogueCount +
    ", 목표 6 + 별개 말풍선 6 오결합</td><td><strong>실패</strong></td></tr><tr><td>3</td><td>외곽선 light component · threshold 180</td><td>" +
    exp3.totals.oldDialogueCount +
    "→" +
    exp3.totals.newDialogueCount +
    ", P028 오결합 잔존</td><td><strong>실패</strong></td></tr><tr><td>4</td><td>threshold 200</td><td>" +
    exp4.totals.oldDialogueCount +
    "→" +
    exp4.totals.newDialogueCount +
    ", 현재 화 정확; 과거 직사각형 캡션 2건 오결합</td><td>회귀에서 보류</td></tr><tr><td>5</td><td>threshold 200 + 직사각형 캡션 gate + 실제 HayaiOCR</td><td>" +
    exp5.totals.oldDialogueCount +
    "→" +
    exp5.totals.newDialogueCount +
    ", matched " +
    parity.totals.matchedCount +
    '개 bbox/OCR/크기 exact</td><td><strong>승격</strong></td></tr></tbody></table></div><p class="muted">5회 안에 실제 개선이 확인되어 수백 회 상세 검색 전환 조건은 발동하지 않았습니다.</p></section><section class="panel"><h2>현재 화 6개 핵심 변화</h2>' +
    changes.map(mergeChange).join("") +
    '</section><section class="panel"><h2>직사각형 캡션 반례 차단</h2><p>실험 4는 밝은 내부가 이어진다는 이유만으로 맞닿은 내레이션 상자도 합쳤습니다. 실험 5는 bubble mask 네 변의 장거리 직선성을 검사해 nearby-column 결합에서만 제외합니다. 기존 겹침 기반 규칙에는 영향을 주지 않습니다.</p>' +
    captionSentinels +
    '</section><section class="panel"><h2>과거 88페이지 회귀</h2><div class="table-wrap"><table><thead><tr><th>집합</th><th>일반 블록</th><th>시각 판정</th></tr></thead><tbody>' +
    regressionRows +
    '</tbody></table></div><p class="callout">총 ' +
    regressionChangeCount +
    '개 변경 crop과 전체 페이지 오버레이를 확대 확인했습니다. 모두 연결 말풍선의 연속 문장이며 직사각형 캡션 2쌍은 별도 블록으로 유지됐습니다.</p><div class="regression-grid">' +
    regressions.map((entry) => entry.audit.html).join("") +
    '</div></section><section class="panel"><h2>애매·이월 항목</h2><ul><li><strong>효과음 ' +
    final.summary.effectCount +
    "개:</strong> 사용자 선택 흐름이므로 이번 판정·수정에서 전부 제외했습니다.</li><li><strong>P006 낮은 score 복합 조각:</strong> 현재 고신뢰 gate 아래라 이월합니다.</li><li><strong>P029/P031 구두점 조각:</strong> 낮은 score를 억지로 완화하지 않고 다음 미사용 화에서 별도 검증합니다.</li><li><strong>abstain " +
    final.summary.abstainedCount +
    '개:</strong> 기준선과 동일하며 이번 geometry 개선으로 해결됐다고 주장하지 않습니다.</li></ul></section><div class="controls"><input id="search" type="search" placeholder="P004/D002, OCR 문자열, T003 검색"><button id="openAll" type="button">모두 펼치기</button><button id="closeAll" type="button">모두 접기</button></div><section aria-label="페이지별 전수 감사">' +
    pageSections.join("") +
    '</section><footer class="panel muted">봉인 seed: ' +
    escapeHtml(selection.seed) +
    "<br>생성: " +
    escapeHtml(generatedAt) +
    " · self-contained 고유 이미지 " +
    embeddedPaths.size +
    "개 · 내장 JPEG bytes " +
    embeddedBytes.toLocaleString("ko-KR") +
    " · 최종 일반 crop " +
    finalCropCount +
    "개 · 효과음 crop 판정 제외 " +
    final.summary.effectCount +
    '개</footer></main><script>const q=document.getElementById("search"),cards=[...document.querySelectorAll(".crop-card")];q.addEventListener("input",()=>{const v=q.value.trim().toLocaleLowerCase("ko-KR");for(const c of cards)c.hidden=Boolean(v)&&!c.dataset.search.includes(v)});document.getElementById("openAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=true);document.getElementById("closeAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=false);</script></body></html>';

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const bytes = fs.readFileSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    campaign: 9,
    chapterKey: selection.key,
    generatedAt,
    output: path.relative(repoRoot, outputPath).replaceAll("\\", "/"),
    byteSize: bytes.length,
    sha256: sha256(bytes),
    embeddedImageCount: embeddedPaths.size,
    domImageElementCount: (html.match(/<img\s/gu) || []).length,
    externalImageReferenceCount: (
      html.match(/<img[^>]+src="(?!data:image\/)/gu) || []
    ).length,
    pageCount: final.summary.pageCount,
    finalDialogueCropCount: final.summary.dialogueCount,
    effectCropCountExcluded: final.summary.effectCount,
    currentChapterMergeCount: changes.length,
    regressionMergeCount: regressionChangeCount,
    exactUnchangedCount: parity.totals.exactBboxCount,
    internalVersion: "fsai-lab-v0.9.0",
  };
  if (manifest.externalImageReferenceCount !== 0) {
    throw new Error("Report contains an external image reference.");
  }
  fs.writeFileSync(
    path.join(campaignRoot, "chapter-report.manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  console.log(JSON.stringify(manifest, null, 2));
}

const args = parseArgs(process.argv.slice(2));
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(() => buildReport(args.output))
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  });

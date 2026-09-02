#!/usr/bin/env electron
/* eslint-disable -- isolated self-contained visual audit report generator */
// @ts-nocheck -- laboratory artifact generator, not production code.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const repoRoot = path.resolve(__dirname, "../..");
const campaignRoot = path.join(
  repoRoot,
  "artifacts",
  "font-size-ai-lab",
  "campaign-005",
);
const baselineRoot = path.join(campaignRoot, "exp-01-v0.4.0-baseline");
const productRoot = path.join(
  campaignRoot,
  "exp-02-narrow-vertical-line-recovery-hayai",
);
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/build-campaign-005-report.cjs " +
          "[--output PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return { output };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmt(value, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  const fixed = Number(value).toFixed(digits);
  return digits > 0 ? fixed.replace(/0+$/u, "").replace(/\.$/u, "") : fixed;
}

function px(value) {
  return Number.isFinite(value) ? `${fmt(value)}px` : "abstain";
}

function candidateKey(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function candidateMap(report) {
  return new Map(
    report.pages.flatMap((page) =>
      page.candidates.map((candidate) => [
        candidateKey(page.pageId, candidate.candidateId),
        candidate,
      ]),
    ),
  );
}

function keyedMap(items) {
  return new Map(
    items.map((item) => [candidateKey(item.pageId, item.candidateId), item]),
  );
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const embeddedPaths = new Set();
const imageCache = new Map();
let embeddedBytes = 0;

function imageDataUri(filePath, maxWidth, quality) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing image: ${filePath}`);
  const absolute = path.resolve(filePath);
  const cacheKey = `${absolute}\u0000${maxWidth}\u0000${quality}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;
  const image = nativeImage.createFromPath(absolute);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${filePath}`);
  const size = image.getSize();
  const resized =
    size.width > maxWidth
      ? image.resize({ width: maxWidth, quality: "best" })
      : image;
  const bytes = resized.toJPEG(quality);
  embeddedPaths.add(absolute);
  embeddedBytes += bytes.length;
  const uri = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  imageCache.set(cacheKey, uri);
  return uri;
}

function imageTag(filePath, alt, maxWidth = 760, quality = 91) {
  return `<img src="${imageDataUri(
    filePath,
    maxWidth,
    quality,
  )}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
}

function tableRows(items, render) {
  return items.length
    ? items.map(render).join("")
    : '<tr><td colspan="9" class="muted">기록 없음</td></tr>';
}

function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const baseline = readJson(path.join(baselineRoot, "baseline-report.json"));
  const product = readJson(path.join(productRoot, "baseline-report.json"));
  const audit = readJson(path.join(campaignRoot, "visual-audit.json"));
  const evaluation = readJson(path.join(productRoot, "evaluation.json"));
  const verdict = readJson(path.join(productRoot, "verdict.json"));

  const beforeById = candidateMap(baseline);
  const changedById = new Map(
    evaluation.changed.map((change) => [change.id, change]),
  );
  const sizeFindingById = keyedMap(audit.fontSizeFindings);
  const geometryById = keyedMap(audit.dialogueGeometryFindings);
  const exclusionById = keyedMap(audit.ordinaryStreamExclusions);
  const pageNotes = new Map(
    audit.pageLevelNotes.map((item) => [item.pageId, item.note]),
  );

  const changedCards = [];
  const pageSections = [];

  for (const page of product.pages) {
    const cards = [];
    for (const candidate of page.candidates) {
      const id = candidateKey(page.pageId, candidate.candidateId);
      const before = beforeById.get(id)?.estimate ?? null;
      const after = candidate.estimate ?? null;
      const changed = changedById.get(id);
      const sizeFinding = sizeFindingById.get(id);
      const geometry = geometryById.get(id);
      const exclusion = exclusionById.get(id);
      const bbox = candidate.bbox;
      const classes = [
        "crop-card",
        changed ? "changed" : "",
        geometry ? "geometry" : "",
        exclusion ? "excluded" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const card = `<article class="${classes}" data-search="${escapeHtml(
        `${id} ${candidate.sourceText} ${candidate.direction} ${
          sizeFinding?.kind ?? ""
        } ${geometry?.kind ?? ""}`.toLocaleLowerCase("ko-KR"),
      )}">
        <div class="crop-image">${imageTag(
          path.join(productRoot, candidate.cropPath),
          `${id} 실제 bbox 개별 확대`,
        )}</div>
        <div class="crop-copy">
          <div class="crop-title"><strong>${escapeHtml(id)}</strong><span>${
            changed ? '<span class="pill good">v0.5.0 개선</span>' : ""
          }${geometry ? '<span class="pill warn">bbox 주의</span>' : ""}${
            exclusion ? '<span class="pill neutral">점수 제외</span>' : ""
          }</span></div>
          <p class="source">${escapeHtml(
            candidate.sourceText || "OCR 문자열 없음",
          )}</p>
          <dl>
            <div><dt>방향</dt><dd>${escapeHtml(candidate.direction)}</dd></div>
            <div><dt>Hayai</dt><dd>${fmt(candidate.hayaiConfidence)}</dd></div>
            <div><dt>bbox</dt><dd>${fmt(bbox.x2 - bbox.x1, 0)}×${fmt(
              bbox.y2 - bbox.y1,
              0,
            )}</dd></div>
            <div><dt>v0.4.0</dt><dd>${px(before?.facePx)}</dd></div>
            <div><dt>v0.5.0</dt><dd>${px(after?.facePx)}</dd></div>
            <div><dt>신뢰도</dt><dd>${fmt(after?.confidence)}</dd></div>
          </dl>
          ${
            sizeFinding
              ? `<p class="finding"><strong>크기 감사:</strong> ${escapeHtml(
                  sizeFinding.note,
                )}</p>`
              : ""
          }
          ${
            geometry
              ? `<p class="finding geometry-copy"><strong>bbox 감사:</strong> ${escapeHtml(
                  geometry.note,
                )}</p>`
              : ""
          }
          ${
            exclusion
              ? `<p class="finding exclusion-copy"><strong>점수 제외:</strong> ${escapeHtml(
                  exclusion.reason,
                )}</p>`
              : ""
          }
        </div>
      </article>`;
      cards.push(card);
      if (changed) changedCards.push(card);
    }

    const containsChange = page.candidates.some((candidate) =>
      changedById.has(candidateKey(page.pageId, candidate.candidateId)),
    );
    pageSections.push(`<details class="page-audit" ${
      containsChange ? "open" : ""
    }>
      <summary><span><strong>${page.pageId}</strong> · ${escapeHtml(
        page.name,
      )}</span><span>일반 텍스트 ${page.dialogueCount}개</span></summary>
      <p class="page-note">${escapeHtml(
        pageNotes.get(page.pageId) ?? "특기할 일반 텍스트 크기·bbox 문제 없음",
      )}</p>
      <figure>${imageTag(
        path.join(productRoot, page.overlayPath),
        `${page.pageId} 실제 HayaiOCR bbox 전체 오버레이`,
        1050,
        88,
      )}<figcaption>전체 페이지의 실제 Text Detector + HayaiOCR 오버레이입니다. 효과음 후보는 사용자 선택 흐름의 별도 대상이므로 크기 판정에서 제외했습니다.</figcaption></figure>
      <div class="crop-grid">${cards.join("")}</div>
    </details>`);
  }

  const expectedImages =
    product.summary.pageCount + product.summary.dialogueCount;
  if (embeddedPaths.size !== expectedImages) {
    throw new Error(
      `Embedded image count mismatch: ${embeddedPaths.size} != ${expectedImages}`,
    );
  }
  if (changedCards.length !== evaluation.summary.changedCount) {
    throw new Error(
      `Changed card count mismatch: ${changedCards.length} != ${evaluation.summary.changedCount}`,
    );
  }

  const findingRows = tableRows(audit.fontSizeFindings, (item) => {
    const id = candidateKey(item.pageId, item.candidateId);
    const changed = changedById.get(id);
    return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(
      item.kind,
    )}</td><td>${escapeHtml(item.severity)}</td><td>${px(
      item.baselineFacePx,
    )}</td><td>${changed ? px(changed.after.facePx) : "유지/이월"}</td><td>${escapeHtml(
      item.note,
    )}</td></tr>`;
  });

  const groupRows = tableRows(audit.sameVisualFontGroups, (group) => {
    const values = group.candidateIds.map((candidateId, index) => {
      const id = candidateKey(group.pageId, candidateId);
      const after = candidateMap(product).get(id)?.estimate?.facePx;
      return `${escapeHtml(candidateId)}: ${px(after ?? group.baselineFacePx[index])}`;
    });
    return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(
      group.pageId,
    )}</td><td>${values.join("<br>")}</td><td>${escapeHtml(
      group.judgement,
    )}</td></tr>`;
  });

  const geometryRows = tableRows(
    audit.dialogueGeometryFindings,
    (item) =>
      `<tr><td>${escapeHtml(candidateKey(item.pageId, item.candidateId))}</td><td>${escapeHtml(
        item.kind,
      )}</td><td>${escapeHtml(item.severity)}</td><td>${escapeHtml(
        item.note,
      )}</td></tr>`,
  );

  const sentinelRows = [
    ...audit.hierarchyMustRemainSmall.map((item) => ({
      ...item,
      tier: "작게 유지",
    })),
    ...audit.hierarchyMustRemainLarge.map((item) => ({
      ...item,
      tier: "크게 유지",
    })),
  ]
    .map(
      (item) =>
        `<tr><td>${escapeHtml(
          candidateKey(item.pageId, item.candidateId),
        )}</td><td>${escapeHtml(item.tier)}</td><td>${px(
          item.baselineFacePx,
        )}</td><td>${escapeHtml(item.judgement)}</td></tr>`,
    )
    .join("");

  const deadEnds = audit.diagnosticDeadEnds
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.hypothesis)}</strong><p>${escapeHtml(
          item.result,
        )}</p><span class="pill bad">${escapeHtml(item.decision)}</span></li>`,
    )
    .join("");

  const deferredRows = tableRows(
    verdict.rejectedOrDeferred,
    (item) =>
      `<tr><td>${escapeHtml(item.hypothesis ?? item.target)}</td><td>${escapeHtml(
        item.decision,
      )}</td><td>${escapeHtml(item.reason)}</td></tr>`,
  );

  const priorRows = ["campaign001", "campaign002", "campaign003", "campaign004"]
    .map((key, index) => {
      const item = verdict.priorCampaignReplay[key];
      return `<tr><td>Campaign ${String(index + 1).padStart(
        3,
        "0",
      )}</td><td>${item.candidateCount}</td><td>${
        item.additionalNarrowRecoveryChanges
      }</td><td>${item.expectedPredictionMismatchCount}</td></tr>`;
    })
    .join("");

  const generatedAt = new Date().toISOString();
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>글자 크기 AI 캠페인 005 · Daisougen no Chiisana Ryoushu Chapter 4</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#657089;--line:#dfe5ef;--blue:#315bd6;--good:#087a55;--warn:#a45b08;--bad:#ba2c2c;--paper:#f5f7fb}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
.shell{max-width:1480px;margin:auto;padding:28px;min-width:0}
.hero,.panel,.page-audit{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 30px #2434580d;min-width:0}
.hero{padding:32px;margin-bottom:20px;background:linear-gradient(135deg,#fff,#eef3ff)}
h1{font-size:clamp(27px,4vw,45px);line-height:1.12;margin:7px 0 12px}
.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.08em}
.lede{max-width:1120px;font-size:17px}
.scope{display:inline-flex;background:#e8f8f1;color:#086445;border:1px solid #a8dec9;border-radius:999px;padding:7px 12px;font-weight:800}
.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px;margin-top:24px}
.metric{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}
.metric strong{display:block;font-size:25px}
.metric span{color:var(--muted)}
.panel{padding:24px;margin:20px 0}
h2{margin:0 0 13px;font-size:24px}
h3{margin:22px 0 10px}
.callout{padding:14px 16px;border-left:4px solid var(--good);background:#edf9f4;border-radius:8px}
.warn-callout{border-color:var(--warn);background:#fff8e8}
.bad-callout{border-color:var(--bad);background:#fff1f1}
.controls{position:sticky;top:0;z-index:10;background:#f5f7fbeb;backdrop-filter:blur(10px);padding:10px 0;display:flex;gap:8px;flex-wrap:wrap}
.controls input{flex:1;min-width:220px;border:1px solid #aeb9cc;border-radius:9px;padding:10px 12px}
.controls button{border:1px solid #aeb9cc;background:#fff;border-radius:9px;padding:9px 12px;cursor:pointer}
.table-wrap{max-width:100%;overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid var(--line);padding:9px;text-align:left;vertical-align:top}
th{background:#f4f6fa}
.changed-grid,.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:13px}
.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-width:0}
.crop-card.changed{border:3px solid #10a575}
.crop-card.geometry{box-shadow:inset 0 0 0 2px #e5a22a}
.crop-card.excluded{background:#fafafa}
.crop-image{display:flex;align-items:center;justify-content:center;min-height:180px;background:#eef1f6;padding:8px}
.crop-image img{display:block;max-width:100%;max-height:590px;object-fit:contain}
.crop-copy{padding:12px}
.crop-title{display:flex;align-items:center;justify-content:space-between;gap:8px}
.crop-title>span{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.source{min-height:2.5em;word-break:break-word}
.pill{display:inline-block;border-radius:999px;padding:2px 7px;font-size:12px;font-weight:800}
.pill.good{color:#06734f;background:#dff7ed}
.pill.bad{color:#9d2323;background:#ffe2e2}
.pill.warn{color:#8d5005;background:#ffedc9}
.pill.neutral{color:#566176;background:#e9edf3}
dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:8px 0}
dl div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #ccd3df}
dt{color:var(--muted)}
dd{margin:0;font-variant-numeric:tabular-nums}
.finding{font-size:13px;background:#fff8e8;padding:8px;border-radius:7px}
.geometry-copy{background:#fff0d6}
.exclusion-copy{background:#edf0f5}
.page-audit{margin:12px 0;overflow:hidden}
.page-audit summary{cursor:pointer;padding:16px 20px;display:flex;justify-content:space-between;gap:10px;background:#fff;font-size:16px}
.page-audit[open] summary{border-bottom:1px solid var(--line)}
.page-note{margin:16px 20px 0;padding:10px 12px;background:#f4f7ff;border-radius:8px}
.page-audit figure{margin:18px auto;max-width:1080px;padding:0 20px}
.page-audit figure img{display:block;max-width:100%;max-height:930px;margin:auto}
.page-audit figcaption{text-align:center;color:var(--muted);margin-top:7px}
.page-audit .crop-grid{padding:0 20px 22px}
.muted{color:var(--muted)}
ul li{margin:12px 0}
ul li p{margin:3px 0}
[hidden]{display:none!important}
@media(max-width:820px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.page-audit summary{padding:13px}.crop-grid,.changed-grid{grid-template-columns:1fr}}
@media(max-width:430px){.metrics{grid-template-columns:1fr}.controls input{min-width:100%}}
</style>
</head>
<body>
<main class="shell">
<section class="hero">
  <div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 005</div>
  <h1>Daisougen no Chiisana Ryoushu · Chapter 4</h1>
  <div class="scope">Text Detector + HayaiOCR 고정 · 일반 텍스트 196개 · 효과음 36개 제외</div>
  <p class="lede">봉인된 미사용 화의 24페이지 전체 오버레이와 일반 텍스트 bbox 196개를 각각 원본 해상도로 확대 감사했습니다. 이번 승격은 좁고 세로로 길다는 이유만으로 글자를 키우지 않습니다. 낮은 신뢰도의 후보가 줄 수를 하나 과하게 나눈 경우에만, 후보 자신의 projection과 major-axis pitch가 같은 크기에 수렴하고 연결 잉크와 페이지 동료가 이를 허용할 때 복구합니다.</p>
  <div class="metrics">
    <div class="metric"><strong>24 / 24</strong><span>전체 페이지 감사</span></div>
    <div class="metric"><strong>196 / 196</strong><span>bbox 개별 확대</span></div>
    <div class="metric"><strong>183 → 183</strong><span>coverage 유지</span></div>
    <div class="metric"><strong>0.2384 → 0.1966</strong><span>같은 글꼴 불일치</span></div>
    <div class="metric"><strong>0 / 776</strong><span>과거 추가 변경</span></div>
  </div>
</section>

<section class="panel">
  <h2>결론 · 내부 버전 ${escapeHtml(verdict.internalVersion)}</h2>
  <p class="callout"><strong>승격:</strong> P022/D002는 15.402px→23.3857px, P023/D001은 17.2381px→26.2189px로 회복됐습니다. 실제 CUDA/cu126 HayaiOCR 재실행은 봉인 예측과 196/196 일치했고, 원천 OCR 증거 불일치도 0입니다.</p>
  <p class="callout warn-callout"><strong>안전장치:</strong> P006/D001의 실제 112.09px 초대형 세로문장과 15px~20px의 정상 소형 문장 5개는 전부 그대로입니다. component와 page peer는 허용 여부만 판단하며 그 숫자를 결과로 복사하지 않습니다.</p>
  <p class="callout bad-callout"><strong>반복 금지:</strong> 모든 narrow-tall을 키우기, 모든 줄 수를 줄이기, page median으로 clamp하기, near-square를 전부 세로로 뒤집기는 금지합니다.</p>
</section>

<section class="panel">
  <h2>실험 기록</h2>
  <div class="table-wrap"><table><thead><tr><th>회차</th><th>가설</th><th>결과</th><th>판정</th></tr></thead><tbody>
    <tr><td>1</td><td>v0.4.0 실제 HayaiOCR 기준선</td><td>24페이지, 일반 텍스트 196개 중 183개 추정; 전 crop 감사</td><td>문제 봉인</td></tr>
    <tr><td>2</td><td>후보 소유 증거 기반 좁은 세로문장 1줄 과분할 복구</td><td>2개 독립 개선, score 0.2384→0.1966, hierarchy penalty 0</td><td>v0.5.0 승격</td></tr>
  </tbody></table></div>
  <p class="muted">명확한 개선이 두 번째 실험에서 나왔으므로 5회 실패 뒤의 200회 이상 상세 검색 조건은 발동하지 않았습니다.</p>
</section>

<section class="panel">
  <h2>이번에 실제로 바뀐 bbox</h2>
  <div class="changed-grid">${changedCards.join("")}</div>
</section>

<section class="panel">
  <h2>과거 화 회귀 재생</h2>
  <p>새 narrow recovery가 과거 4개 화 776개 후보에 추가로 손댄 항목은 0개이며, 누적 제품 예상값과의 불일치도 0개입니다.</p>
  <div class="table-wrap"><table><thead><tr><th>화</th><th>후보</th><th>새 규칙 추가 변경</th><th>예상값 불일치</th></tr></thead><tbody>${priorRows}</tbody></table></div>
</section>

<section class="panel">
  <h2>글자 크기 감사 판정</h2>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>유형</th><th>심각도</th><th>v0.4.0</th><th>v0.5.0</th><th>판정</th></tr></thead><tbody>${findingRows}</tbody></table></div>
</section>

<section class="panel">
  <h2>같은 시각 글꼴 그룹</h2>
  <div class="table-wrap"><table><thead><tr><th>그룹</th><th>페이지</th><th>v0.5.0 값</th><th>감사 메모</th></tr></thead><tbody>${groupRows}</tbody></table></div>
</section>

<section class="panel">
  <h2>크기 계층 회귀 방지 센티널</h2>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>계층</th><th>봉인값</th><th>근거</th></tr></thead><tbody>${sentinelRows}</tbody></table></div>
</section>

<section class="panel">
  <h2>일반 텍스트 bbox 문제</h2>
  <p class="muted">효과음 오검출은 사용자 선택 흐름에서 별도로 처리하므로 제외했습니다. 아래에는 크기 추정을 오염시킬 수 있는 일반 텍스트 containment/association 문제만 적었습니다.</p>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>유형</th><th>심각도</th><th>메모</th></tr></thead><tbody>${geometryRows}</tbody></table></div>
</section>

<section class="panel">
  <h2>실패 조합 씨육수</h2>
  <ul>${deadEnds}</ul>
  <h3>기각·이월 상세</h3>
  <div class="table-wrap"><table><thead><tr><th>가설/대상</th><th>판정</th><th>이유</th></tr></thead><tbody>${deferredRows}</tbody></table></div>
</section>

<div class="controls">
  <input id="search" type="search" placeholder="P022/D002, OCR 문자열, 문제 유형 검색">
  <button id="openAll" type="button">모든 페이지 펼치기</button>
  <button id="closeAll" type="button">모든 페이지 접기</button>
</div>

<section aria-label="페이지별 전체 감사">${pageSections.join("")}</section>

<footer class="panel muted">
  봉인 seed: ${escapeHtml(selection.seed)}<br>
  생성: ${escapeHtml(generatedAt)} · self-contained 고유 이미지 ${
    embeddedPaths.size
  }개 · 내장 JPEG bytes ${embeddedBytes.toLocaleString("ko-KR")}
</footer>
</main>
<script>
const search=document.getElementById("search");
const cards=[...document.querySelectorAll(".crop-card")];
search.addEventListener("input",()=>{
  const query=search.value.trim().toLocaleLowerCase("ko-KR");
  for(const card of cards)card.hidden=Boolean(query)&&!card.dataset.search.includes(query);
});
document.getElementById("openAll").onclick=()=>document.querySelectorAll(".page-audit").forEach((item)=>{item.open=true;});
document.getElementById("closeAll").onclick=()=>document.querySelectorAll(".page-audit").forEach((item)=>{item.open=false;});
</script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const htmlBytes = fs.readFileSync(outputPath);
  const domImageElementCount = (html.match(/<img\s/gu) ?? []).length;
  const externalImageReferenceCount = (
    html.match(/<img[^>]+src="(?!data:image\/)/gu) ?? []
  ).length;
  const manifest = {
    schemaVersion: 1,
    campaign: 5,
    chapterKey: selection.key,
    generatedAt,
    output: path.relative(repoRoot, outputPath).replaceAll("\\", "/"),
    byteSize: htmlBytes.length,
    sha256: sha256Bytes(htmlBytes),
    embeddedImageCount: embeddedPaths.size,
    expectedEmbeddedImageCount: expectedImages,
    domImageElementCount,
    externalImageReferenceCount,
    sourceImageBytes: embeddedBytes,
    pageCount: product.summary.pageCount,
    dialogueCropCount: product.summary.dialogueCount,
    effectCropCountExcluded: product.summary.effectCount,
    changedCandidateCount: evaluation.summary.changedCount,
    internalVersion: verdict.internalVersion,
  };
  fs.writeFileSync(
    path.join(campaignRoot, "chapter-report.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
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
    console.error(error?.stack || error);
    app.exit(1);
  });

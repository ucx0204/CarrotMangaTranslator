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
const campaignRoot = path.join(labRoot, "campaign-008");
const baselineRoot = path.join(campaignRoot, "exp-01-v0.7.0-baseline");
const candidateV1Root = path.join(campaignRoot, "exp-05-v0.8.0-candidate");
const finalRoot = path.join(campaignRoot, "exp-05-v0.8.0-candidate-r2");
const campaign007BaselineRoot = path.join(
  labRoot,
  "campaign-007",
  "exp-04-strip-tail-repair-actual",
);
const campaign007FinalRoot = path.join(
  campaignRoot,
  "regression-campaign-007-actual-v0.8.0-r2",
);
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
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
  return Number(value).toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "");
}

function px(value) {
  return Number.isFinite(value) ? `${fmt(value)}px` : "abstain";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const imageCache = new Map();
const embeddedPaths = new Set();
let embeddedBytes = 0;

function imageDataUri(filePath, maxWidth = 900, quality = 90) {
  const absolute = path.resolve(filePath);
  const key = `${absolute}\0${maxWidth}\0${quality}`;
  if (imageCache.has(key)) return imageCache.get(key);
  if (!fs.existsSync(absolute)) throw new Error(`Missing image: ${absolute}`);
  let image = nativeImage.createFromPath(absolute);
  if (image.isEmpty()) throw new Error(`Could not decode image: ${absolute}`);
  if (image.getSize().width > maxWidth) {
    image = image.resize({ width: maxWidth, quality: "best" });
  }
  const bytes = image.toJPEG(quality);
  const uri = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  imageCache.set(key, uri);
  embeddedPaths.add(absolute);
  embeddedBytes += bytes.length;
  return uri;
}

function imageTag(filePath, alt, maxWidth, quality) {
  return `<img src="${imageDataUri(filePath, maxWidth, quality)}" alt="${escapeHtml(
    alt,
  )}" loading="lazy" decoding="async">`;
}

function sourceKey(region) {
  return [...region.sourceDetectionIds].sort().join("+");
}

function readCandidateBySource(root, pageId, detectionIds) {
  const pageRoot = path.join(root, "pages", pageId);
  const manifest = readJson(path.join(pageRoot, "ocr", "hayai-regions.json"));
  const report = readJson(path.join(pageRoot, "page.json"));
  const key = [...detectionIds].sort().join("+");
  const region = manifest.dialogueRegions.find(
    (entry) => sourceKey(entry) === key,
  );
  if (!region) throw new Error(`Missing ${pageId}/${key} in ${root}`);
  const candidate = report.candidates.find(
    (entry) => entry.candidateId === region.regionId,
  );
  if (!candidate) throw new Error(`Missing ${pageId}/${region.regionId}`);
  return { candidate, region };
}

function candidateCard({ candidate, pageId, root, badges = [], note = "" }) {
  const bbox = candidate.bbox;
  const search = [
    pageId,
    candidate.candidateId,
    candidate.sourceText,
    candidate.direction,
    ...badges,
    note,
  ]
    .join(" ")
    .toLocaleLowerCase("ko-KR");
  return `<article class="crop-card" data-search="${escapeHtml(search)}">
    <div class="crop-image">${imageTag(
      path.join(root, candidate.cropPath),
      `${pageId}/${candidate.candidateId} 실제 확대`,
      780,
      93,
    )}</div>
    <div class="crop-copy"><div class="crop-title"><strong>${escapeHtml(
      `${pageId}/${candidate.candidateId}`,
    )}</strong><span>${badges
      .map((badge) => `<i>${escapeHtml(badge)}</i>`)
      .join("")}</span></div>
    <p class="source">${escapeHtml(candidate.sourceText || "OCR 문자열 없음")}</p>
    <dl><div><dt>방향</dt><dd>${escapeHtml(candidate.direction)}</dd></div>
      <div><dt>bbox</dt><dd>${fmt(bbox.x2 - bbox.x1, 0)}×${fmt(
        bbox.y2 - bbox.y1,
        0,
      )}</dd></div>
      <div><dt>추정 크기</dt><dd>${px(candidate.estimate?.facePx)}</dd></div>
      <div><dt>크기 신뢰도</dt><dd>${fmt(candidate.estimate?.confidence)}</dd></div>
      <div><dt>Hayai</dt><dd>${fmt(candidate.hayaiConfidence)}</dd></div></dl>
    ${note ? `<p class="note">${escapeHtml(note)}</p>` : ""}</div></article>`;
}

function overlayPair(beforeRoot, afterRoot, pageId, beforeLabel, afterLabel) {
  return `<div class="overlay-pair"><figure>${imageTag(
    path.join(beforeRoot, "pages", pageId, "bbox-overlay.png"),
    `${pageId} ${beforeLabel}`,
    1100,
    89,
  )}<figcaption>${escapeHtml(beforeLabel)}</figcaption></figure><figure>${imageTag(
    path.join(afterRoot, "pages", pageId, "bbox-overlay.png"),
    `${pageId} ${afterLabel}`,
    1100,
    89,
  )}<figcaption>${escapeHtml(afterLabel)}</figcaption></figure></div>`;
}

function mergeComparison({
  title,
  pageId,
  beforeRoot,
  beforeSources,
  afterRoot,
  afterSources,
  verdict,
}) {
  const before = beforeSources.map((ids) =>
    readCandidateBySource(beforeRoot, pageId, ids),
  );
  const after = afterSources.map((ids) =>
    readCandidateBySource(afterRoot, pageId, ids),
  );
  return `<section class="change"><h3>${escapeHtml(`${pageId} · ${title}`)}</h3>
    <div class="before-after"><div><h4>이전</h4><div class="crop-grid">${before
      .map(({ candidate }) =>
        candidateCard({
          candidate,
          pageId,
          root: beforeRoot,
          badges: ["분리"],
        }),
      )
      .join("")}</div></div><div><h4>v0.8.0</h4><div class="crop-grid">${after
      .map(({ candidate }) =>
        candidateCard({
          candidate,
          pageId,
          root: afterRoot,
          badges: ["재결합", "실제 HayaiOCR"],
        }),
      )
      .join("")}</div></div></div>
    <p class="callout"><strong>판정:</strong> ${escapeHtml(verdict)}</p>
    ${overlayPair(beforeRoot, afterRoot, pageId, "이전", "재결합 후")}</section>`;
}

function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const baseline = readJson(path.join(baselineRoot, "baseline-report.json"));
  const candidateV1 = readJson(
    path.join(candidateV1Root, "baseline-report.json"),
  );
  const final = readJson(path.join(finalRoot, "baseline-report.json"));
  const parity = readJson(
    path.join(campaignRoot, "actual-chapter-parity-r2.json"),
  );
  const campaign007Parity = readJson(
    path.join(campaignRoot, "regression-campaign-007-actual-parity-r2.json"),
  );
  const campaign006Regression = readJson(
    path.join(
      campaignRoot,
      "regression-campaign-006",
      "geometry-evaluation.json",
    ),
  );
  const campaign001Regression = readJson(
    path.join(
      campaignRoot,
      "regression-campaign-001",
      "geometry-evaluation.json",
    ),
  );

  const mainChange = mergeComparison({
    title: "말풍선 안에서 끊긴 ‘殿下…ください’를 한 문장으로 복구",
    pageId: "P015",
    beforeRoot: baselineRoot,
    beforeSources: [["T018"], ["T016"]],
    afterRoot: finalRoot,
    afterSources: [["T016", "T018"]],
    verdict:
      "OCR 순서가 ‘殿下ご自分に価値がないなんて思わないでください’로 이어졌고, 세로 방향을 유지한 채 추정 크기가 27.557px(합친 빈 공간 기준)에서 33.572px(원래 두 글자 덩어리 기준)로 교정됐다.",
  });

  const campaign007Changes = [
    mergeComparison({
      title: "‘あっ’ + ‘あいつ生徒会の…っ’ 재결합",
      pageId: "P006",
      beforeRoot: campaign007BaselineRoot,
      beforeSources: [["T015"], ["T008"]],
      afterRoot: campaign007FinalRoot,
      afterSources: [["T008", "T015"]],
      verdict:
        "같은 말풍선의 한 문장으로 자연스럽게 이어진다. 두 원래 세그먼트의 크기를 함께 사용해 최종 31.786px로 측정했다.",
    }),
    mergeComparison({
      title: "‘ひどい…’ + ‘一体誰がこんな事を!?’ 재결합",
      pageId: "P017",
      beforeRoot: campaign007BaselineRoot,
      beforeSources: [["T035"], ["T019"]],
      afterRoot: campaign007FinalRoot,
      afterSources: [["T019", "T035"]],
      verdict:
        "합친 bbox가 거의 정사각형이어도 원 세그먼트 다수가 세로이므로 세로 방향을 보존한다. 잘못된 가로 측정 42.1442px 대신 28.4233px가 됐다.",
    }),
  ].join("");

  const p009Before = readCandidateBySource(candidateV1Root, "P009", [
    "T001",
    "T010",
  ]);
  const p009After = readCandidateBySource(finalRoot, "P009", ["T001", "T010"]);
  const measurementSafeguard = `<section class="change"><h3>P009 · 이미 합쳐져 있던 문장의 측정 안전장치</h3>
    <div class="before-after"><div><h4>union crop 측정</h4>${candidateCard({
      candidate: p009Before.candidate,
      pageId: "P009",
      root: candidateV1Root,
      badges: ["31.9813px"],
    })}</div><div><h4>원 세그먼트 측정</h4>${candidateCard({
      candidate: p009After.candidate,
      pageId: "P009",
      root: finalRoot,
      badges: ["27.637px"],
    })}</div></div>
    <p class="callout"><strong>판정:</strong> bbox와 OCR은 완전히 같고, 가운데 큰 빈 공간을 글자 크기로 세지 않도록 위·아래 실제 글자 덩어리를 각각 측정했다.</p></section>`;

  const pageNotes = {
    P009: "D004는 이미 두 OCR 세그먼트였으며 bbox/OCR은 그대로, 측정 근거만 실제 두 글자 덩어리로 바뀌었다.",
    P015: "D005가 이번 핵심 개선: 분리됐던 ‘殿下’와 이어지는 본문을 한 문장으로 재결합했다.",
  };
  const pageSections = [];
  let finalCropCount = 0;
  for (const page of final.pages) {
    const cards = page.candidates
      .map((candidate) => {
        finalCropCount += 1;
        const badges = [];
        if (page.pageId === "P015" && candidate.candidateId === "D005") {
          badges.push("v0.8.0 핵심 개선");
        }
        if (page.pageId === "P009" && candidate.candidateId === "D004") {
          badges.push("세그먼트 측정");
        }
        return candidateCard({
          candidate,
          pageId: page.pageId,
          root: finalRoot,
          badges,
        });
      })
      .join("");
    pageSections.push(`<details class="page" ${page.pageId === "P015" ? "open" : ""}>
      <summary><strong>${page.pageId}</strong><span>일반 텍스트 ${page.dialogueCount}개</span></summary>
      ${
        pageNotes[page.pageId]
          ? `<p class="page-note">${escapeHtml(pageNotes[page.pageId])}</p>`
          : ""
      }
      <figure>${imageTag(
        path.join(finalRoot, page.overlayPath),
        `${page.pageId} 최종 HayaiOCR bbox 오버레이`,
        1100,
        89,
      )}<figcaption>빨강: 일반 텍스트 · 파랑: 효과음 후보(사용자 선택 영역, 이번 판정 제외)</figcaption></figure>
      <div class="crop-grid page-crops">${cards}</div></details>`);
  }
  if (finalCropCount !== final.summary.dialogueCount) {
    throw new Error(`Final crop count mismatch: ${finalCropCount}`);
  }

  const generatedAt = new Date().toISOString();
  const title = `${selection.series} · ${selection.chapter}`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>글자 크기 AI 캠페인 008 · ${escapeHtml(selection.chapter)}</title><style>
:root{color-scheme:light;--ink:#172033;--muted:#68738a;--line:#dce3ee;--good:#087a55;--bad:#b32929;--blue:#315bd6;--paper:#f4f6fa}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}.shell{max-width:1480px;margin:auto;padding:26px}.hero,.panel,.page{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 28px #2638590d}.hero{padding:32px;background:linear-gradient(135deg,#fff,#edf4ff)}h1{font-size:clamp(25px,3.4vw,42px);line-height:1.14;margin:8px 0}.eyebrow{color:var(--blue);font-weight:850;letter-spacing:.08em}.scope{display:inline-block;margin-top:10px;padding:7px 12px;border-radius:999px;background:#e2f7ef;color:#086345;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px;margin-top:22px}.metric{border:1px solid var(--line);border-radius:12px;padding:13px;background:#fff}.metric strong{display:block;font-size:24px}.metric span,.muted{color:var(--muted)}.panel{padding:24px;margin:18px 0}h2{margin:0 0 12px;font-size:24px}h3{font-size:20px}.callout{padding:13px 15px;border-left:4px solid var(--good);background:#ebf9f3;border-radius:8px}.callout.bad{border-color:var(--bad);background:#fff0f0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f3f6fa}.change{border-top:1px solid var(--line);padding:18px 0}.change:first-of-type{border-top:0}.before-after,.overlay-pair{display:grid;grid-template-columns:1fr 1fr;gap:15px}.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-width:0}.crop-image{display:flex;align-items:center;justify-content:center;min-height:170px;padding:8px;background:#eef1f6}.crop-image img{display:block;max-width:100%;max-height:590px;object-fit:contain}.crop-copy{padding:11px}.crop-title{display:flex;justify-content:space-between;gap:8px}.crop-title span{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}.crop-title i{font-style:normal;font-size:11px;font-weight:800;padding:2px 6px;border-radius:999px;background:#dff5ec;color:#087250}.source{min-height:2.5em}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px}dl div{display:flex;justify-content:space-between;border-bottom:1px dotted #cbd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.note{padding:8px;border-radius:7px;background:#fff4d8}.overlay-pair figure{margin:8px 0}.overlay-pair img{display:block;max-width:100%;max-height:840px;margin:auto}.overlay-pair figcaption{text-align:center;color:var(--muted)}.page{margin:12px 0;overflow:hidden}.page summary{display:flex;justify-content:space-between;padding:15px 18px;cursor:pointer}.page[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:14px 18px 0;padding:9px 11px;background:#f1f5ff;border-radius:8px}.page>figure{margin:17px auto;max-width:1110px;padding:0 18px}.page>figure img{display:block;max-width:100%;max-height:960px;margin:auto}.page>figure figcaption{text-align:center;color:var(--muted)}.page-crops{padding:0 18px 20px}.controls{position:sticky;top:0;z-index:5;padding:10px 0;background:#f4f6fae8;backdrop-filter:blur(10px);display:flex;gap:8px}.controls input{flex:1;min-width:220px;padding:10px;border:1px solid #aeb8ca;border-radius:9px}.controls button{padding:9px;border:1px solid #aeb8ca;border-radius:9px;background:#fff}[hidden]{display:none!important}@media(max-width:900px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.before-after,.overlay-pair{grid-template-columns:1fr}.crop-grid{grid-template-columns:1fr}}@media(max-width:430px){.metrics{grid-template-columns:1fr}.controls{flex-wrap:wrap}.controls input{min-width:100%}}
</style></head><body><main class="shell"><section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 008</div><h1>${escapeHtml(
    title,
  )}</h1><div class="scope">Koharu Text Detector + HayaiOCR CUDA/cu126 · 효과음 ${final.summary.effectCount}개 제외</div>
<p>18페이지 전체와 최종 일반 텍스트 140개를 원본 확대 감사했습니다. 이번 개선은 같은 말풍선 안에서 detector가 작은 선두·꼬리 조각을 별도 문장으로 끊은 경우만 엄격한 정렬·겹침·소속 조건으로 재결합합니다.</p><div class="metrics"><div class="metric"><strong>18 / 18</strong><span>전체 페이지 확대</span></div><div class="metric"><strong>140 / 140</strong><span>최종 일반 crop 확대</span></div><div class="metric"><strong>1</strong><span>현재 화 문장 복구</span></div><div class="metric"><strong>139 / 139</strong><span>나머지 bbox·OCR exact</span></div><div class="metric"><strong>5 / 5</strong><span>실험 사용</span></div></div></section>
<section class="panel"><h2>결론 · 내부 버전 fsai-lab-v0.8.0</h2><p class="callout"><strong>승격 후보:</strong> P015의 끊긴 세로 문장을 한 블록으로 복구했고 실제 HayaiOCR 문자열·순서·세로 방향과 글자 크기 근거까지 일치시켰습니다. 직전 화에서도 같은 유형 2건이 올바르게 합쳐졌으며 118개 나머지 bbox/OCR은 exact입니다.</p><p class="callout bad"><strong>반복 금지:</strong> 작은 조각의 mask 면적 비율만 0.15로 내린 실험 2와 겹침 허용만 0.25로 올린 실험 3은 변화가 0건이었습니다. 점수 문턱을 그대로 둔 채 이 두 조합을 다시 시도하지 않습니다.</p></section>
<section class="panel"><h2>5회 실험 기록</h2><div class="table-wrap"><table><thead><tr><th>회차</th><th>가설</th><th>실제 결과</th><th>판정</th></tr></thead><tbody>
<tr><td>1</td><td>v0.7.0 실제 HayaiOCR 기준선</td><td>141개. P015 한 말풍선에서 ‘殿下’와 뒤 문장이 2개로 분리</td><td>문제 확정</td></tr>
<tr><td>2</td><td>작은 mask 면적 비율 0.35→0.15</td><td>141→141, 변경 0</td><td><strong>실패 · 재사용 금지</strong></td></tr>
<tr><td>3</td><td>면적 0.15 + mask 겹침 0.2→0.25</td><td>141→141, 변경 0; score 문턱에 계속 막힘</td><td><strong>실패 · 재사용 금지</strong></td></tr>
<tr><td>4</td><td>동일 말풍선·bbox 교차·축 겹침 0.95·분리 0.35를 유지하고 score 0.9→0.85</td><td>141→140, P015 한 건만 변경, 17페이지 exact</td><td>geometry 성공</td></tr>
<tr><td>5</td><td>실제 HayaiOCR + 원 recognition segment 방향·측정 보존</td><td>140개, OCR 완전 연결; P015 33.572px, 직전 화 2건도 올바른 재결합</td><td><strong>승격</strong></td></tr></tbody></table></div><p class="muted">5회 안에 실제 개선이 확인되어 수백 회 상세 검색 전환 조건은 발동하지 않았습니다.</p></section>
<section class="panel"><h2>현재 화 핵심 변화</h2>${mainChange}${measurementSafeguard}</section>
<section class="panel"><h2>직전 화 실제 회귀 변화</h2>${campaign007Changes}</section>
<section class="panel"><h2>회귀와 보수성</h2><div class="table-wrap"><table><thead><tr><th>집합</th><th>기계 대조</th><th>판정</th></tr></thead><tbody>
<tr><td>현재 화 18페이지</td><td>${baseline.summary.dialogueCount}→${final.summary.dialogueCount}; matched ${parity.totals.matchedCount}; bbox/OCR exact ${parity.totals.exactBboxCount}</td><td>P015의 2개가 1개로 정확히 결합</td></tr>
<tr><td>직전 캠페인 007 · 20페이지</td><td>122→120; matched ${campaign007Parity.totals.matchedCount}; bbox/OCR exact ${campaign007Parity.totals.exactBboxCount}</td><td>P006/P017 한 문장씩 정확히 결합</td></tr>
<tr><td>캠페인 006 · 18페이지</td><td>${campaign006Regression.totals.oldDialogueCount}→${campaign006Regression.totals.newDialogueCount}, 변경 ${campaign006Regression.totals.changedCount}</td><td>v0.7.0에서 이미 승인한 변화 외 추가 변화 없음</td></tr>
<tr><td>캠페인 001 · 32페이지</td><td>${campaign001Regression.totals.oldDialogueCount}→${campaign001Regression.totals.newDialogueCount}, 변경 ${campaign001Regression.totals.changedCount}, 거부 ${campaign001Regression.totals.rejectedDialogueCount}</td><td>v0.7.0에서 이미 승인한 변화와 동일</td></tr></tbody></table></div></section>
<section class="panel"><h2>애매·이월 항목</h2><ul><li><strong>효과음 ${final.summary.effectCount}개:</strong> 사용자가 직접 고르는 별도 흐름이므로 이번 실험·회귀·승격 판정에서 전부 제외했습니다.</li><li><strong>근정사각 union bbox:</strong> 원 recognition segment가 있으면 다수 방향을 사용합니다. 세그먼트가 없는 근정사각 일본어 블록의 방향 판정은 별도 캠페인 후보로 남깁니다.</li><li><strong>P009 D004:</strong> bbox/OCR은 같고 측정 근거만 union의 큰 빈 공간에서 실제 위·아래 글자 덩어리로 바뀌었습니다.</li></ul></section>
<div class="controls"><input id="search" type="search" placeholder="P015/D005, OCR 문자열, 세그먼트 검색"><button id="openAll" type="button">모두 펼치기</button><button id="closeAll" type="button">모두 접기</button></div>
<section aria-label="페이지별 전수 감사">${pageSections.join("")}</section>
<footer class="panel muted">봉인 seed: ${escapeHtml(selection.seed)}<br>생성: ${escapeHtml(
    generatedAt,
  )} · self-contained 고유 이미지 ${embeddedPaths.size}개 · 내장 JPEG bytes ${embeddedBytes.toLocaleString(
    "ko-KR",
  )} · 최종 일반 crop ${finalCropCount}개 · 효과음 crop 판정 제외 ${final.summary.effectCount}개</footer>
</main><script>const q=document.getElementById("search"),cards=[...document.querySelectorAll(".crop-card")];q.addEventListener("input",()=>{const v=q.value.trim().toLocaleLowerCase("ko-KR");for(const c of cards)c.hidden=Boolean(v)&&!c.dataset.search.includes(v)});document.getElementById("openAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=true);document.getElementById("closeAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=false);</script></body></html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const bytes = fs.readFileSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    campaign: 8,
    chapterKey: selection.key,
    generatedAt,
    output: path.relative(repoRoot, outputPath).replaceAll("\\", "/"),
    byteSize: bytes.length,
    sha256: sha256(bytes),
    embeddedImageCount: embeddedPaths.size,
    domImageElementCount: (html.match(/<img\s/gu) ?? []).length,
    externalImageReferenceCount: (
      html.match(/<img[^>]+src="(?!data:image\/)/gu) ?? []
    ).length,
    pageCount: final.summary.pageCount,
    finalDialogueCropCount: final.summary.dialogueCount,
    effectCropCountExcluded: final.summary.effectCount,
    internalVersion: "fsai-lab-v0.8.0",
  };
  if (manifest.externalImageReferenceCount !== 0) {
    throw new Error("Report contains an external image reference.");
  }
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

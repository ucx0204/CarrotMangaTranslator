#!/usr/bin/env electron
/* eslint-disable -- isolated self-contained chapter report generator */
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
  "campaign-007",
);
const baselineRoot = path.join(campaignRoot, "exp-01-v0.6.0-baseline");
const finalRoot = path.join(campaignRoot, "exp-04-strip-tail-repair-actual");
const campaign006RegressionRoot = path.join(
  campaignRoot,
  "regression-campaign-006",
);
const campaign001RegressionRoot = path.join(
  campaignRoot,
  "regression-campaign-001",
);
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
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

function imageDataUri(filePath, maxWidth = 900, quality = 89) {
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
  return `<img src="${imageDataUri(
    filePath,
    maxWidth,
    quality,
  )}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
}

function sourceKey(region) {
  return [...region.sourceDetectionIds].sort().join("+");
}

function readCandidateBySource(root, pageId, detectionIds) {
  const pageRoot = path.join(root, "pages", pageId);
  const manifest = readJson(path.join(pageRoot, "ocr", "hayai-regions.json"));
  const report = readJson(path.join(pageRoot, "page.json"));
  const targetKey = [...detectionIds].sort().join("+");
  const region = manifest.dialogueRegions.find(
    (item) => sourceKey(item) === targetKey,
  );
  if (!region) throw new Error(`Missing ${pageId}/${targetKey} in ${root}`);
  const candidate = report.candidates.find(
    (item) => item.candidateId === region.regionId,
  );
  if (!candidate)
    throw new Error(`Missing candidate ${pageId}/${region.regionId}`);
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
      760,
      92,
    )}</div>
    <div class="crop-copy">
      <div class="crop-title"><strong>${escapeHtml(
        `${pageId}/${candidate.candidateId}`,
      )}</strong><span>${badges
        .map((badge) => `<i>${escapeHtml(badge)}</i>`)
        .join("")}</span></div>
      <p class="source">${escapeHtml(candidate.sourceText || "OCR 문자열 없음")}</p>
      <dl>
        <div><dt>방향</dt><dd>${escapeHtml(candidate.direction)}</dd></div>
        <div><dt>bbox</dt><dd>${fmt(bbox.x2 - bbox.x1, 0)}×${fmt(
          bbox.y2 - bbox.y1,
          0,
        )}</dd></div>
        <div><dt>추정 크기</dt><dd>${px(candidate.estimate?.facePx)}</dd></div>
        <div><dt>크기 신뢰도</dt><dd>${fmt(candidate.estimate?.confidence)}</dd></div>
        <div><dt>Hayai</dt><dd>${fmt(candidate.hayaiConfidence)}</dd></div>
      </dl>
      ${note ? `<p class="note">${escapeHtml(note)}</p>` : ""}
    </div>
  </article>`;
}

function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const baseline = readJson(path.join(baselineRoot, "baseline-report.json"));
  const final = readJson(path.join(finalRoot, "baseline-report.json"));
  const parity = readJson(
    path.join(campaignRoot, "actual-chapter-parity.json"),
  );
  const campaign006Regression = readJson(
    path.join(campaign006RegressionRoot, "geometry-evaluation.json"),
  );
  const campaign001Regression = readJson(
    path.join(campaign001RegressionRoot, "geometry-evaluation.json"),
  );

  const changes = [
    {
      pageId: "P009",
      sourceIds: ["T032"],
      title: "패널 여러 개를 가로지른 982px 꼬리 제거",
      verdict:
        "본문 core는 보존되고 OCR이 잡문장에서 ‘俺が壁(捕手)’로 정리됐으며 추정 크기도 47.7648px에서 25.5848px로 정상화됐다.",
      remaining:
        "오른쪽의 손글씨 ‘やるわ’는 Koharu 원 예측과 mask core 밖이라 여전히 포함되지 않는다. 이번 꼬리 수리와 별개의 부분 검출 누락으로 이월한다.",
    },
    {
      pageId: "P017",
      sourceIds: ["T036"],
      title: "패널 위쪽 단일 잡점 때문에 늘어난 854px 꼬리 제거",
      verdict:
        "단순 삭제 실험에서 잃었던 ‘まて!’를 41×110px 로컬 블록으로 복구했다. OCR은 ‘いからまて!’에서 ‘まて!’로 정리됐고 abstain도 18.4383px 측정으로 바뀌었다.",
      remaining: "명확한 잔여 문제 없음.",
    },
  ];

  const changeSections = changes
    .map((change) => {
      const before = readCandidateBySource(
        baselineRoot,
        change.pageId,
        change.sourceIds,
      );
      const after = readCandidateBySource(
        finalRoot,
        change.pageId,
        change.sourceIds,
      );
      return `<section class="change">
        <h3>${escapeHtml(`${change.pageId} · ${change.title}`)}</h3>
        <div class="before-after"><div><h4>v0.6.0 기준선</h4>${candidateCard({
          candidate: before.candidate,
          pageId: change.pageId,
          root: baselineRoot,
          badges: ["긴 오검출"],
        })}</div><div><h4>v0.7.0 후보</h4>${candidateCard({
          candidate: after.candidate,
          pageId: change.pageId,
          root: finalRoot,
          badges: ["꼬리 수리", "실제 HayaiOCR"],
        })}</div></div>
        <p class="callout"><strong>판정:</strong> ${escapeHtml(change.verdict)}</p>
        <p class="note"><strong>남은 점:</strong> ${escapeHtml(change.remaining)}</p>
        <div class="overlay-pair"><figure>${imageTag(
          path.join(baselineRoot, "pages", change.pageId, "bbox-overlay.png"),
          `${change.pageId} v0.6.0 전체 오버레이`,
          1080,
          88,
        )}<figcaption>이전</figcaption></figure><figure>${imageTag(
          path.join(finalRoot, "pages", change.pageId, "bbox-overlay.png"),
          `${change.pageId} v0.7.0 전체 오버레이`,
          1080,
          88,
        )}<figcaption>수리 후</figcaption></figure></div>
      </section>`;
    })
    .join("");

  const changedKeys = new Set(["P009/T032", "P017/T036"]);
  const pageNotes = {
    P009: "T032의 먼 약한 꼬리를 제거했다. 옆 손글씨 ‘やるわ’ 부분 누락은 이월한다.",
    P016: "D001은 v0.6.0이 인접한 두 캡션 조각을 읽기 순서대로 묶은 상태다. 시각적으로 별도 캡션일 가능성도 있어 애매 사례로 기록하고 이번 임계값에는 사용하지 않았다.",
    P017: "T036의 위쪽 단일 잡점을 제거해 ‘まて!’를 버리지 않고 로컬 블록으로 복구했다.",
  };
  const pageSections = [];
  let finalCropCount = 0;
  for (const page of final.pages) {
    const pageRoot = path.join(finalRoot, "pages", page.pageId);
    const manifest = readJson(path.join(pageRoot, "ocr", "hayai-regions.json"));
    const sourceByRegion = new Map(
      manifest.dialogueRegions.map((region) => [
        region.regionId,
        sourceKey(region),
      ]),
    );
    const cards = page.candidates
      .map((candidate) => {
        finalCropCount += 1;
        const key = `${page.pageId}/${sourceByRegion.get(candidate.candidateId)}`;
        const badges = [];
        if (changedKeys.has(key)) badges.push("v0.7.0 변경");
        if (page.pageId === "P016" && candidate.candidateId === "D001") {
          badges.push("애매 사례");
        }
        return candidateCard({
          candidate,
          pageId: page.pageId,
          root: finalRoot,
          badges,
          note:
            changedKeys.has(key) && key === "P009/T032"
              ? "‘やるわ’ 부분 검출 누락은 별도 이월"
              : "",
        });
      })
      .join("");
    const open = ["P009", "P016", "P017"].includes(page.pageId);
    pageSections.push(`<details class="page" ${open ? "open" : ""}>
      <summary><strong>${page.pageId}</strong><span>일반 텍스트 ${page.dialogueCount}개</span></summary>
      ${
        pageNotes[page.pageId]
          ? `<p class="page-note">${escapeHtml(pageNotes[page.pageId])}</p>`
          : ""
      }
      <figure>${imageTag(
        path.join(finalRoot, page.overlayPath),
        `${page.pageId} 최종 HayaiOCR bbox 오버레이`,
        1080,
        88,
      )}<figcaption>빨강: 일반 텍스트 · 파랑: 효과음 후보(사용자 선택 영역, 이번 판정 제외)</figcaption></figure>
      <div class="crop-grid page-crops">${cards}</div>
    </details>`);
  }

  const historicalVisuals = `<div class="regression-grid">
    <figure>${imageTag(
      path.join(
        campaign006RegressionRoot,
        "pages",
        "P011",
        "old-orange-new-green.png",
      ),
      "캠페인 006 P011 회귀: 주황 이전, 초록 현재",
      1080,
      88,
    )}<figcaption>캠페인 006 P011 · 주황 64×1026px 횡단 박스가 초록 로컬 블록으로 수리됨</figcaption></figure>
    <figure>${imageTag(
      path.join(
        campaign001RegressionRoot,
        "pages",
        "P019",
        "old-orange-new-green.png",
      ),
      "캠페인 001 P019 회귀: 연재 추천 띠",
      1080,
      88,
    )}<figcaption>캠페인 001 P019 · 바깥 추천 띠만 좁아지고 컷 안 대사는 보존</figcaption></figure>
    <figure>${imageTag(
      path.join(
        campaign001RegressionRoot,
        "pages",
        "P031",
        "old-orange-new-green.png",
      ),
      "캠페인 001 P031 회귀: 연재 추천 띠",
      1080,
      88,
    )}<figcaption>캠페인 001 P031 · 바깥 추천 띠 변화의 대표 사례</figcaption></figure>
  </div>`;

  if (finalCropCount !== final.summary.dialogueCount) {
    throw new Error(`Final crop count mismatch: ${finalCropCount}`);
  }
  const expectedUniqueImages =
    final.summary.pageCount + final.summary.dialogueCount + 7;
  if (embeddedPaths.size !== expectedUniqueImages) {
    throw new Error(
      `Embedded image mismatch: ${embeddedPaths.size} != ${expectedUniqueImages}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const title = "Danshi Koukousei… · Chapter 4";
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>글자 크기 AI 캠페인 007 · ${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#68738a;--line:#dce3ee;--good:#087a55;--bad:#b32929;--blue:#315bd6;--paper:#f4f6fa}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}.shell{max-width:1480px;margin:auto;padding:26px}.hero,.panel,.page{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 28px #2638590d}.hero{padding:32px;background:linear-gradient(135deg,#fff,#edf4ff)}h1{font-size:clamp(27px,4vw,44px);line-height:1.12;margin:8px 0}.eyebrow{color:var(--blue);font-weight:850;letter-spacing:.08em}.scope{display:inline-block;margin-top:10px;padding:7px 12px;border-radius:999px;background:#e2f7ef;color:#086345;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px;margin-top:22px}.metric{border:1px solid var(--line);border-radius:12px;padding:13px;background:#fff}.metric strong{display:block;font-size:24px}.metric span,.muted{color:var(--muted)}.panel{padding:24px;margin:18px 0}h2{margin:0 0 12px;font-size:24px}h3{font-size:20px}.callout{padding:13px 15px;border-left:4px solid var(--good);background:#ebf9f3;border-radius:8px}.callout.bad{border-color:var(--bad);background:#fff0f0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f3f6fa}.change{border-top:1px solid var(--line);padding:18px 0}.change:first-of-type{border-top:0}.before-after,.overlay-pair{display:grid;grid-template-columns:1fr 1fr;gap:15px}.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-width:0}.crop-image{display:flex;align-items:center;justify-content:center;min-height:170px;padding:8px;background:#eef1f6}.crop-image img{display:block;max-width:100%;max-height:570px;object-fit:contain}.crop-copy{padding:11px}.crop-title{display:flex;justify-content:space-between;gap:8px}.crop-title span{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}.crop-title i{font-style:normal;font-size:11px;font-weight:800;padding:2px 6px;border-radius:999px;background:#dff5ec;color:#087250}.source{min-height:2.5em}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px}dl div{display:flex;justify-content:space-between;border-bottom:1px dotted #cbd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.note{padding:8px;border-radius:7px;background:#fff4d8}.overlay-pair figure,.regression-grid figure{margin:8px 0}.overlay-pair img,.regression-grid img{display:block;max-width:100%;max-height:820px;margin:auto}.overlay-pair figcaption,.regression-grid figcaption{text-align:center;color:var(--muted)}.regression-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.page{margin:12px 0;overflow:hidden}.page summary{display:flex;justify-content:space-between;padding:15px 18px;cursor:pointer}.page[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:14px 18px 0;padding:9px 11px;background:#f1f5ff;border-radius:8px}.page>figure{margin:17px auto;max-width:1110px;padding:0 18px}.page>figure img{display:block;max-width:100%;max-height:940px;margin:auto}.page>figure figcaption{text-align:center;color:var(--muted)}.page-crops{padding:0 18px 20px}.controls{position:sticky;top:0;z-index:5;padding:10px 0;background:#f4f6fae8;backdrop-filter:blur(10px);display:flex;gap:8px}.controls input{flex:1;min-width:220px;padding:10px;border:1px solid #aeb8ca;border-radius:9px}.controls button{padding:9px;border:1px solid #aeb8ca;border-radius:9px;background:#fff}[hidden]{display:none!important}@media(max-width:900px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.before-after,.overlay-pair,.regression-grid{grid-template-columns:1fr}.crop-grid{grid-template-columns:1fr}}@media(max-width:430px){.metrics{grid-template-columns:1fr}.controls{flex-wrap:wrap}.controls input{min-width:100%}}
</style></head><body><main class="shell">
<section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 007</div><h1>${escapeHtml(
    title,
  )}</h1><div class="scope">Koharu Text Detector + HayaiOCR CUDA/cu126 · 효과음 27개 제외</div><p>20페이지 전체와 일반 텍스트 122개를 각각 원본 확대 감사했습니다. 이번 개선은 세로폭이 비정상적으로 길어진 검출을 통째로 버리지 않고, 큰 빈 간격 너머의 극소수 mask 잡점만 제거해 실제 글자 core를 보존합니다.</p><div class="metrics"><div class="metric"><strong>20 / 20</strong><span>전체 페이지 확대</span></div><div class="metric"><strong>122 / 122</strong><span>일반 crop 확대</span></div><div class="metric"><strong>2</strong><span>실제 문제 수리</span></div><div class="metric"><strong>120 / 120</strong><span>나머지 exact parity</span></div><div class="metric"><strong>70</strong><span>총 회귀 페이지</span></div></div></section>
<section class="panel"><h2>결론 · 내부 버전 fsai-lab-v0.7.0</h2><p class="callout"><strong>승격:</strong> P009와 P017의 페이지 횡단 세로 꼬리를 각각 로컬 글자 블록으로 복구했습니다. 두 블록 모두 실제 HayaiOCR 문자열과 크기 추정이 개선됐고, 나머지 120개는 bbox·OCR·추정 크기가 모두 같습니다.</p><p class="callout bad"><strong>반복 금지:</strong> 세로폭 40%·종횡비 12 이상을 곧바로 삭제하는 실험 2는 P017의 실제 ‘まて!’까지 없앴습니다. 앞으로는 큰 빈 간격과 약한 쪽 mask 면적 8% 이하가 함께 확인될 때만 꼬리를 자릅니다.</p></section>
<section class="panel"><h2>4회 실험 기록</h2><div class="table-wrap"><table><thead><tr><th>회차</th><th>가설</th><th>실제 결과</th><th>판정</th></tr></thead><tbody><tr><td>1</td><td>v0.6.0 실제 HayaiOCR 기준선</td><td>122개 중 P009 55×982, P017 45×854 페이지 횡단 박스 확인</td><td>문제 확정</td></tr><tr><td>2</td><td>극단 세로 strip 즉시 거부</td><td>P009/P017 둘 다 사라졌지만 P017의 ‘まて!’도 함께 손실</td><td><strong>실패 · 폐기</strong></td></tr><tr><td>3</td><td>큰 빈 간격 너머 약한 mask 꼬리만 제거</td><td>두 글자 core 보존, 나머지 120 geometry exact</td><td>성공 후보</td></tr><tr><td>4</td><td>현재 제품 경로 + 실제 HayaiOCR 재실행</td><td>OCR 2건 개선, 측정 114→115, 나머지 120 exact</td><td><strong>승격</strong></td></tr></tbody></table></div><p class="muted">4/5회 안에 명확한 개선이 나와 수백 회 상세 검색 전환 조건은 발동하지 않았습니다.</p></section>
<section class="panel"><h2>실제로 달라진 두 블록</h2>${changeSections}</section>
<section class="panel"><h2>회귀와 보수성</h2><div class="table-wrap"><table><thead><tr><th>집합</th><th>결과</th><th>육안 판정</th></tr></thead><tbody><tr><td>현재 화 20페이지</td><td>122→122, bbox/OCR/크기 변경 2, 나머지 120 exact</td><td>P009/P017 개선</td></tr><tr><td>캠페인 006 · 18페이지</td><td>${campaign006Regression.totals.oldDialogueCount}→${campaign006Regression.totals.newDialogueCount}, 변경 ${campaign006Regression.totals.changedCount}, 거부 ${campaign006Regression.totals.rejectedDialogueCount}</td><td>P011의 과거 64×1026 횡단 박스도 수리; 이웃 2개는 정상 폭 회복</td></tr><tr><td>캠페인 001 · 32페이지</td><td>${campaign001Regression.totals.oldDialogueCount}→${campaign001Regression.totals.newDialogueCount}, 변경 ${campaign001Regression.totals.changedCount}, 거부 ${campaign001Regression.totals.rejectedDialogueCount}</td><td>변경 화면 전수 확인: 컷 바깥 연재·추천 띠만 제거/축소, 컷 안 대사 보존</td></tr></tbody></table></div><p class="note">P009의 이웃 segmented recognition 경계는 overlap 관계가 바뀌며 1.5px 달라졌지만 OCR과 추정 크기는 동일했습니다. 기능 퇴행으로 세지 않습니다.</p>${historicalVisuals}</section>
<section class="panel"><h2>애매·이월 항목</h2><ul><li><strong>P009 ‘やるわ’:</strong> 원 detector box와 dense mask core 밖의 손글씨라 부분 누락 상태다. 별도 검출 재현 없이는 이번 꼬리 규칙에 섞지 않는다.</li><li><strong>P016 D001:</strong> v0.6.0이 두 인접 캡션 조각을 순서대로 합친 결과지만, 시각적으로 별도 캡션일 가능성도 있다. 애매 사례로 기록하고 이번 승격 근거에서 제외했다.</li><li><strong>효과음 27개:</strong> 사용자가 직접 선택하는 별도 흐름이므로 실험·회귀·승격 판단에서 모두 제외했다.</li></ul></section>
<div class="controls"><input id="search" type="search" placeholder="P009/D012, OCR 문자열, 애매 사례 검색"><button id="openAll" type="button">모두 펼치기</button><button id="closeAll" type="button">모두 접기</button></div>
<section aria-label="페이지별 전수 감사">${pageSections.join("")}</section>
<footer class="panel muted">봉인 seed: ${escapeHtml(
    selection.seed,
  )}<br>생성: ${escapeHtml(generatedAt)} · self-contained 고유 이미지 ${
    embeddedPaths.size
  }개 · 내장 JPEG bytes ${embeddedBytes.toLocaleString("ko-KR")} · 실제 parity ${
    parity.totals.exactBboxCount
  } exact / ${parity.totals.changedBboxCount} changed</footer>
</main><script>const q=document.getElementById("search"),cards=[...document.querySelectorAll(".crop-card")];q.addEventListener("input",()=>{const v=q.value.trim().toLocaleLowerCase("ko-KR");for(const c of cards)c.hidden=Boolean(v)&&!c.dataset.search.includes(v)});document.getElementById("openAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=true);document.getElementById("closeAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=false);</script></body></html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const bytes = fs.readFileSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    campaign: 7,
    chapterKey: selection.key,
    generatedAt,
    output: path.relative(repoRoot, outputPath).replaceAll("\\", "/"),
    byteSize: bytes.length,
    sha256: sha256(bytes),
    embeddedImageCount: embeddedPaths.size,
    expectedEmbeddedImageCount: expectedUniqueImages,
    domImageElementCount: (html.match(/<img\s/gu) ?? []).length,
    externalImageReferenceCount: (
      html.match(/<img[^>]+src="(?!data:image\/)/gu) ?? []
    ).length,
    pageCount: final.summary.pageCount,
    finalDialogueCropCount: final.summary.dialogueCount,
    effectCropCountExcluded: final.summary.effectCount,
    changedDialogueCount: parity.totals.changedBboxCount,
    exactDialogueCount: parity.totals.exactBboxCount,
    internalVersion: "fsai-lab-v0.7.0",
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

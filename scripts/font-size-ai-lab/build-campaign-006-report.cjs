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
  "campaign-006",
);
const baselineRoot = path.join(campaignRoot, "exp-01-v0.5.0-baseline");
const naiveRoot = path.join(campaignRoot, "exp-02-fragment-rejoin", "actual");
const finalRoot = path.join(
  campaignRoot,
  "exp-03-segmented-fragment-rejoin",
  "actual",
);
const verdictRoot = path.join(campaignRoot, "exp-03-segmented-fragment-rejoin");
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

function candidateMap(report) {
  return new Map(
    report.pages.flatMap((page) =>
      page.candidates.map((candidate) => [
        `${page.pageId}/${candidate.candidateId}`,
        candidate,
      ]),
    ),
  );
}

function candidateCard({
  candidate,
  pageId,
  root,
  badges = [],
  note = "",
  version = "v0.6.0",
}) {
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
        <div><dt>${escapeHtml(version)}</dt><dd>${px(
          candidate.estimate?.facePx,
        )}</dd></div>
        <div><dt>크기 신뢰도</dt><dd>${fmt(
          candidate.estimate?.confidence,
        )}</dd></div>
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
  const audit = readJson(path.join(campaignRoot, "visual-audit.json"));
  const evaluation = readJson(path.join(verdictRoot, "evaluation.json"));
  const verdict = readJson(path.join(verdictRoot, "verdict.json"));
  const beforeById = candidateMap(baseline);
  const finalById = candidateMap(final);
  const findingById = new Map();
  for (const item of audit.clearTextAbstentions) {
    findingById.set(`${item.pageId}/${item.candidateId}`, {
      badge: "명확한 abstain",
      note: `다음 실험 후보 · ${item.kind}`,
    });
  }
  for (const item of audit.intentionalAbstentions) {
    findingById.set(`${item.pageId}/${item.candidateId}`, {
      badge: "의도한 abstain",
      note: item.reason,
    });
  }
  for (const item of audit.nextFontSizeCandidates) {
    findingById.set(`${item.pageId}/${item.candidateId}`, {
      badge: "크기 재검토",
      note: item.note,
    });
  }
  for (const item of audit.geometryFindings.filter(
    (finding) => finding.status !== "fixed-v0.6.0",
  )) {
    for (const candidateId of item.baselineCandidateIds) {
      findingById.set(`${item.pageId}/${candidateId}`, {
        badge: `bbox ${item.status}`,
        note: item.note,
      });
    }
  }

  const changedSections = evaluation.fragments
    .map((fragment) => {
      const oldCards = fragment.old
        .map((record) => {
          const candidate = beforeById.get(
            `${fragment.pageId}/${record.candidateId}`,
          );
          return candidateCard({
            candidate,
            pageId: fragment.pageId,
            root: baselineRoot,
            badges: ["v0.5.0 분할 조각"],
            version: "v0.5.0",
          });
        })
        .join("");
      const nextCandidate = finalById.get(
        `${fragment.pageId}/${fragment.segmented.candidateId}`,
      );
      const nextCard = candidateCard({
        candidate: nextCandidate,
        pageId: fragment.pageId,
        root: finalRoot,
        badges: ["v0.6.0 논리 블록", "조각별 OCR"],
        note: `recognition segment ${fragment.segmented.recognitionBboxes.length}개`,
      });
      return `<section class="change">
        <h3>${fragment.pageId} · ${fragment.old
          .map((item) => item.regionId)
          .join(" + ")} → ${fragment.segmented.regionId}</h3>
        <div class="before-after"><div><h4>이전 조각</h4><div class="crop-grid">${oldCards}</div></div><div><h4>최종 논리 블록</h4>${nextCard}</div></div>
        <div class="ocr-compare"><p><strong>단순 union 실패:</strong> ${escapeHtml(
          fragment.naive.ocrText,
        )}</p><p><strong>조각별 HayaiOCR 성공:</strong> ${escapeHtml(
          fragment.segmented.ocrText,
        )}</p></div>
      </section>`;
    })
    .join("");

  const pageSections = [];
  let finalCropCount = 0;
  for (const page of final.pages) {
    const manifest = readJson(
      path.join(finalRoot, "pages", page.pageId, "ocr", "hayai-regions.json"),
    );
    const mergedIds = new Set(
      manifest.dialogueRegions
        .filter((region) => Array.isArray(region.recognitionBboxes))
        .map((region) => region.regionId),
    );
    const cards = page.candidates
      .map((candidate) => {
        finalCropCount += 1;
        const finding = findingById.get(
          `${page.pageId}/${candidate.candidateId}`,
        );
        const badges = [];
        if (mergedIds.has(candidate.candidateId)) badges.push("v0.6.0 병합");
        if (finding) badges.push(finding.badge);
        return candidateCard({
          candidate,
          pageId: page.pageId,
          root: finalRoot,
          badges,
          note: finding?.note ?? "",
        });
      })
      .join("");
    const open = mergedIds.size > 0 || page.pageId === "P011";
    pageSections.push(`<details class="page" ${open ? "open" : ""}>
      <summary><strong>${page.pageId}</strong><span>일반 텍스트 ${page.dialogueCount}개</span></summary>
      <p class="page-note">${escapeHtml(audit.pageNotes[page.pageId])}</p>
      <figure>${imageTag(
        path.join(finalRoot, page.overlayPath),
        `${page.pageId} 전체 HayaiOCR bbox 오버레이`,
        1080,
        88,
      )}<figcaption>빨강: 일반 텍스트 · 파랑: 사용자 선택 효과음 후보(판정 제외)</figcaption></figure>
      <div class="crop-grid page-crops">${cards}</div>
    </details>`);
  }

  const issueRows = audit.geometryFindings
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.pageId)}</td><td>${escapeHtml(
          item.baselineCandidateIds.join(" + "),
        )}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(
          item.status,
        )}</td><td>${escapeHtml(item.note)}</td></tr>`,
    )
    .join("");
  const abstainRows = audit.clearTextAbstentions
    .map(
      (item) =>
        `<tr><td>${escapeHtml(
          `${item.pageId}/${item.candidateId}`,
        )}</td><td>${escapeHtml(item.kind)}</td><td>후속 크기 실험</td></tr>`,
    )
    .join("");
  const experimentRows = verdict.experiments
    .map(
      (item) =>
        `<tr><td>${item.index}</td><td>${escapeHtml(
          item.name,
        )}</td><td>${escapeHtml(item.result)}</td><td>${escapeHtml(
          item.decision,
        )}</td></tr>`,
    )
    .join("");

  const expectedUniqueImages =
    final.summary.pageCount + final.summary.dialogueCount + 6;
  if (finalCropCount !== final.summary.dialogueCount) {
    throw new Error(`Final crop count mismatch: ${finalCropCount}`);
  }
  if (embeddedPaths.size !== expectedUniqueImages) {
    throw new Error(
      `Embedded image mismatch: ${embeddedPaths.size} != ${expectedUniqueImages}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const title = "Tada no Murabito… · Chapter 10.1";
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>글자 크기 AI 캠페인 006 · ${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#68738a;--line:#dce3ee;--good:#087a55;--bad:#b32929;--blue:#315bd6;--paper:#f4f6fa}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}.shell{max-width:1480px;margin:auto;padding:26px}.hero,.panel,.page{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 28px #2638590d}.hero{padding:32px;background:linear-gradient(135deg,#fff,#edf4ff)}h1{font-size:clamp(27px,4vw,44px);line-height:1.12;margin:8px 0}.eyebrow{color:var(--blue);font-weight:850;letter-spacing:.08em}.scope{display:inline-block;margin-top:10px;padding:7px 12px;border-radius:999px;background:#e2f7ef;color:#086345;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px;margin-top:22px}.metric{border:1px solid var(--line);border-radius:12px;padding:13px;background:#fff}.metric strong{display:block;font-size:24px}.metric span,.muted{color:var(--muted)}.panel{padding:24px;margin:18px 0}h2{margin:0 0 12px;font-size:24px}.callout{padding:13px 15px;border-left:4px solid var(--good);background:#ebf9f3;border-radius:8px}.callout.bad{border-color:var(--bad);background:#fff0f0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f3f6fa}.change{border-top:1px solid var(--line);padding:18px 0}.change:first-of-type{border-top:0}.before-after{display:grid;grid-template-columns:1.35fr 1fr;gap:15px}.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-width:0}.crop-image{display:flex;align-items:center;justify-content:center;min-height:170px;padding:8px;background:#eef1f6}.crop-image img{display:block;max-width:100%;max-height:570px;object-fit:contain}.crop-copy{padding:11px}.crop-title{display:flex;justify-content:space-between;gap:8px}.crop-title span{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}.crop-title i{font-style:normal;font-size:11px;font-weight:800;padding:2px 6px;border-radius:999px;background:#dff5ec;color:#087250}.source{min-height:2.5em}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px}dl div{display:flex;justify-content:space-between;border-bottom:1px dotted #cbd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.note,.ocr-compare{padding:8px;border-radius:7px;background:#fff4d8}.ocr-compare{margin-top:10px}.ocr-compare p{margin:5px}.page{margin:12px 0;overflow:hidden}.page summary{display:flex;justify-content:space-between;padding:15px 18px;cursor:pointer}.page[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:14px 18px 0;padding:9px 11px;background:#f1f5ff;border-radius:8px}.page figure{margin:17px auto;max-width:1110px;padding:0 18px}.page figure img{display:block;max-width:100%;max-height:940px;margin:auto}.page figcaption{text-align:center;color:var(--muted)}.page-crops{padding:0 18px 20px}.controls{position:sticky;top:0;z-index:5;padding:10px 0;background:#f4f6fae8;backdrop-filter:blur(10px);display:flex;gap:8px}.controls input{flex:1;min-width:220px;padding:10px;border:1px solid #aeb8ca;border-radius:9px}.controls button{padding:9px;border:1px solid #aeb8ca;border-radius:9px;background:#fff}[hidden]{display:none!important}@media(max-width:840px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.before-after{grid-template-columns:1fr}.crop-grid{grid-template-columns:1fr}}@media(max-width:430px){.metrics{grid-template-columns:1fr}.controls{flex-wrap:wrap}.controls input{min-width:100%}}
</style></head><body><main class="shell">
<section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 006</div><h1>${escapeHtml(
    title,
  )}</h1><div class="scope">Text Detector + HayaiOCR 고정 · 효과음 31개 판정 제외</div><p>18페이지 전체와 기준선 일반 텍스트 164개를 각각 원본 확대 감사했습니다. 이번 개선은 같은 말풍선에서 갈라진 조각을 하나의 논리 블록으로 복원하되, HayaiOCR은 각 조각을 따로 읽어 정확한 열 순서를 보존합니다.</p><div class="metrics"><div class="metric"><strong>18 / 18</strong><span>전체 페이지</span></div><div class="metric"><strong>164 / 164</strong><span>기준 bbox 확대</span></div><div class="metric"><strong>3</strong><span>논리 블록 복원</span></div><div class="metric"><strong>3 / 3</strong><span>OCR 순서 정확</span></div><div class="metric"><strong>158 / 158</strong><span>나머지 exact parity</span></div></div></section>
<section class="panel"><h2>결론 · 내부 버전 ${escapeHtml(
    verdict.internalVersion,
  )}</h2><p class="callout"><strong>승격:</strong> P005, P009, P011의 명확한 동일 말풍선 분할을 복원했습니다. 최종 OCR은 세 건 모두 이전 두 조각의 정확한 읽기 순서와 일치하며, 나머지 158개 논리 영역은 bbox·OCR·추정 크기가 전부 동일합니다.</p><p class="callout bad"><strong>반복 금지:</strong> 조각을 먼저 큰 crop 하나로 합쳐 HayaiOCR에 넣는 방식은 P005와 P011의 열 순서를 섞었습니다. 논리 geometry 결합과 recognition crop 결합을 다시 혼동하지 않습니다.</p></section>
<section class="panel"><h2>실험 기록</h2><div class="table-wrap"><table><thead><tr><th>회차</th><th>가설</th><th>결과</th><th>판정</th></tr></thead><tbody>${experimentRows}</tbody></table></div><p class="muted">3/5회 안에 명확한 개선이 나와 수백 회 상세 검색 전환 조건은 발동하지 않았습니다.</p></section>
<section class="panel"><h2>실제로 달라진 세 블록</h2>${changedSections}</section>
<section class="panel"><h2>bbox 감사와 이월 항목</h2><div class="table-wrap"><table><thead><tr><th>페이지</th><th>기준 ID</th><th>유형</th><th>상태</th><th>메모</th></tr></thead><tbody>${issueRows}</tbody></table></div></section>
<section class="panel"><h2>다음 크기 연구의 명확한 abstain</h2><p>말줄임표·단일 문장부호 4개와 P011 선형 오검출은 별도입니다. 아래 8개는 실제 글자가 분명한데도 크기 추정을 포기했습니다.</p><div class="table-wrap"><table><thead><tr><th>ID</th><th>유형</th><th>조치</th></tr></thead><tbody>${abstainRows}</tbody></table></div></section>
<div class="controls"><input id="search" type="search" placeholder="P005/D004, OCR 문자열, abstain 검색"><button id="openAll" type="button">모두 펼치기</button><button id="closeAll" type="button">모두 접기</button></div>
<section aria-label="페이지별 전수 감사">${pageSections.join("")}</section>
<footer class="panel muted">봉인 seed: ${escapeHtml(
    selection.seed,
  )}<br>생성: ${escapeHtml(generatedAt)} · self-contained 고유 이미지 ${
    embeddedPaths.size
  }개 · 내장 JPEG bytes ${embeddedBytes.toLocaleString("ko-KR")}</footer>
</main><script>const q=document.getElementById("search"),cards=[...document.querySelectorAll(".crop-card")];q.addEventListener("input",()=>{const v=q.value.trim().toLocaleLowerCase("ko-KR");for(const c of cards)c.hidden=Boolean(v)&&!c.dataset.search.includes(v)});document.getElementById("openAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=true);document.getElementById("closeAll").onclick=()=>document.querySelectorAll(".page").forEach(x=>x.open=false);</script></body></html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const bytes = fs.readFileSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    campaign: 6,
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
    baselineDialogueCropCount: baseline.summary.dialogueCount,
    finalDialogueCropCount: final.summary.dialogueCount,
    effectCropCountExcluded: final.summary.effectCount,
    changedLogicalRegionCount: evaluation.summary.logicalFragmentMerges,
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

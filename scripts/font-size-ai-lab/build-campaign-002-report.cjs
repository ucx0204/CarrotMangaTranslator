#!/usr/bin/env electron
/* eslint-disable -- isolated visual audit report generator */
// @ts-nocheck -- laboratory artifact generator, not production code.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const { PNG } = require("pngjs");

const repoRoot = path.resolve(__dirname, "../..");
const campaignRoot = path.join(
  repoRoot,
  "artifacts",
  "font-size-ai-lab",
  "campaign-002",
);
const sourceRoot = path.join(campaignRoot, "exp-01-r1-component-affinity");
const experimentRoot = path.join(
  campaignRoot,
  "exp-02-three-geometry-consensus",
);
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/build-campaign-002-report.cjs " +
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

function candidateKey(pageId, candidateId) {
  return `${pageId}/${candidateId}`;
}

function predictionMap(evaluation) {
  return new Map(
    evaluation.predictions.map((item) => [
      candidateKey(item.pageId, item.candidateId),
      item,
    ]),
  );
}

function toPng(image) {
  if (image.isEmpty()) throw new Error("Could not decode report image.");
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const png = new PNG({ height, width });
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    png.data[offset] = bgra[offset + 2] ?? 0;
    png.data[offset + 1] = bgra[offset + 1] ?? 0;
    png.data[offset + 2] = bgra[offset] ?? 0;
    png.data[offset + 3] = bgra[offset + 3] ?? 255;
  }
  return png;
}

function drawRectangle(png, bbox, color = [220, 38, 38], thickness = 3) {
  const x1 = Math.max(0, Math.min(png.width - 1, Math.round(bbox.x1)));
  const x2 = Math.max(0, Math.min(png.width - 1, Math.round(bbox.x2)));
  const y1 = Math.max(0, Math.min(png.height - 1, Math.round(bbox.y1)));
  const y2 = Math.max(0, Math.min(png.height - 1, Math.round(bbox.y2)));
  const paint = (x, y) => {
    const offset = (y * png.width + x) * 4;
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = 255;
  };
  for (let step = 0; step < thickness; step += 1) {
    const left = Math.min(x2, x1 + step);
    const right = Math.max(x1, x2 - step);
    const top = Math.min(y2, y1 + step);
    const bottom = Math.max(y1, y2 - step);
    for (let x = left; x <= right; x += 1) {
      paint(x, top);
      paint(x, bottom);
    }
    for (let y = top; y <= bottom; y += 1) {
      paint(left, y);
      paint(right, y);
    }
  }
}

const imageData = Object.create(null);
let encodedImageBytes = 0;

function registerNativeImage(image, maxWidth = 900, quality = 88) {
  if (image.isEmpty()) throw new Error("Empty report image.");
  const size = image.getSize();
  const resized =
    size.width > maxWidth
      ? image.resize({ width: maxWidth, quality: "best" })
      : image;
  const bytes = resized.toJPEG(quality);
  const key = `image-${String(Object.keys(imageData).length + 1).padStart(4, "0")}`;
  imageData[key] = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  encodedImageBytes += bytes.length;
  return key;
}

function registerPath(filePath, maxWidth = 760, quality = 90) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing image: ${filePath}`);
  return registerNativeImage(
    nativeImage.createFromPath(filePath),
    maxWidth,
    quality,
  );
}

function registerDialogueOverlay(page) {
  const image = nativeImage.createFromPath(page.imagePath);
  const png = toPng(image);
  for (const candidate of page.candidates) {
    drawRectangle(png, candidate.bbox, [220, 38, 38], 3);
  }
  return registerNativeImage(
    nativeImage.createFromBuffer(PNG.sync.write(png)),
    980,
    87,
  );
}

function imageTag(key, alt, className = "") {
  return `<img class="${escapeHtml(className)}" data-image="${escapeHtml(
    key,
  )}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
}

function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const baselineReport = readJson(
    path.join(sourceRoot, "baseline-report.json"),
  );
  const audit = readJson(path.join(campaignRoot, "visual-audit.json"));
  const projection = readJson(path.join(sourceRoot, "projection-score.json"));
  const finalEvaluation = readJson(
    path.join(experimentRoot, "module-evaluation-r3.json"),
  );
  const verdict = readJson(path.join(experimentRoot, "verdict.json"));
  const campaignOneRegression = readJson(
    path.join(
      repoRoot,
      "artifacts",
      "font-size-ai-lab",
      "campaign-001",
      "exp-05-hayai-validation",
      "source-size-evaluation-v0.2.0-regression-r2.json",
    ),
  );
  const projectionById = predictionMap(projection);
  const finalById = predictionMap(finalEvaluation);
  const changedById = new Map(
    verdict.changedOrdinaryDialogue.map((item) => [item.id, item]),
  );
  const geometryById = new Map();
  for (const finding of audit.dialogueGeometryFindings) {
    for (const candidateId of finding.candidateIds ?? [finding.candidateId]) {
      geometryById.set(candidateKey(finding.pageId, candidateId), finding);
    }
  }
  const pageNotes = new Map(
    audit.pageLevelNotes.map((item) => [item.pageId, item.note]),
  );

  const fixedDiagnostic = registerPath(
    path.join(
      repoRoot,
      "artifacts",
      "font-size-ai-lab",
      "fixed-diagnostics",
      "narrow-tall-missing-face-2026-09-02",
      "user-observed-before.png",
    ),
    520,
    94,
  );

  const changedCards = [];
  const pageSections = [];
  for (const page of baselineReport.pages) {
    const overlayKey = registerDialogueOverlay(page);
    const cards = [];
    for (const candidate of page.candidates) {
      const id = candidateKey(page.pageId, candidate.candidateId);
      const before = projectionById.get(id)?.estimate ?? null;
      const after = finalById.get(id)?.estimate ?? null;
      const changed = changedById.get(id);
      const geometry = geometryById.get(id);
      const cropKey = registerPath(path.join(sourceRoot, candidate.cropPath));
      const bbox = candidate.bbox;
      const card = `<article class="crop-card ${changed ? "changed" : ""} ${
        geometry ? "geometry" : ""
      }" data-search="${escapeHtml(
        `${id} ${candidate.sourceText} ${candidate.direction}`.toLocaleLowerCase(
          "ko-KR",
        ),
      )}">
        <div class="crop-image">${imageTag(cropKey, `${id} 원본 해상도 확대`)}</div>
        <div class="crop-copy">
          <div class="crop-title"><strong>${escapeHtml(id)}</strong>${
            changed ? '<span class="pill good">v0.2.0 개선</span>' : ""
          }</div>
          <p class="source">${escapeHtml(candidate.sourceText || "OCR 문자열 없음")}</p>
          <dl>
            <div><dt>방향</dt><dd>${escapeHtml(candidate.direction)}</dd></div>
            <div><dt>bbox</dt><dd>${fmt(bbox.x1, 0)}, ${fmt(bbox.y1, 0)} – ${fmt(
              bbox.x2,
              0,
            )}, ${fmt(bbox.y2, 0)}</dd></div>
            <div><dt>v0.1.1</dt><dd>${Number.isFinite(before?.facePx) ? `${fmt(before.facePx)}px` : "abstain"}</dd></div>
            <div><dt>v0.2.0</dt><dd>${Number.isFinite(after?.facePx) ? `${fmt(after.facePx)}px` : "abstain"}</dd></div>
            <div><dt>신뢰도</dt><dd>${fmt(after?.confidence)}</dd></div>
          </dl>
          ${
            geometry
              ? `<p class="finding"><strong>bbox 감사:</strong> ${escapeHtml(
                  geometry.note,
                )} <span class="pill warn">${escapeHtml(geometry.severity)}</span></p>`
              : ""
          }
        </div>
      </article>`;
      cards.push(card);
      if (changed) changedCards.push(card);
    }
    pageSections.push(`<details class="page-audit" ${
      page.candidates.some((candidate) =>
        changedById.has(candidateKey(page.pageId, candidate.candidateId)),
      )
        ? "open"
        : ""
    }>
      <summary><span><strong>${page.pageId}</strong> · ${escapeHtml(
        page.name,
      )}</span><span>${page.dialogueCount}개 일반 텍스트</span></summary>
      <div class="page-note">${escapeHtml(
        pageNotes.get(page.pageId) ?? "특기할 일반 텍스트 문제 없음",
      )}</div>
      <figure>${imageTag(
        overlayKey,
        `${page.pageId} 일반 대사 전용 전체 오버레이`,
      )}<figcaption>빨간 사각형은 일반 대사/텍스트만 표시합니다. FX는 그리지 않았습니다.</figcaption></figure>
      <div class="crop-grid">${cards.join("")}</div>
    </details>`);
  }

  const sameFontRows = audit.sameVisualFontGroups
    .map((group) => {
      const finalGroup = finalEvaluation.sameFontGroups.find(
        (item) => item.id === group.id,
      );
      return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(
        group.pageId,
      )}</td><td>${group.candidateIds.length}</td><td>${fmt(
        finalGroup?.score,
      )}</td><td>${fmt(finalGroup?.coverage)}</td><td>${escapeHtml(
        group.judgement,
      )}</td></tr>`;
    })
    .join("");
  const geometryRows = audit.dialogueGeometryFindings
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.pageId)}</td><td>${escapeHtml(
          item.candidateId ?? item.candidateIds.join(", "),
        )}</td><td>${escapeHtml(item.severity)}</td><td>${escapeHtml(
          item.kind,
        )}</td><td>${escapeHtml(item.note)}</td></tr>`,
    )
    .join("");
  const generatedAt = new Date().toISOString();
  const imageJson = JSON.stringify(imageData).replaceAll("<", "\\u003c");
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>글자 크기 AI 캠페인 002 · Chapter 2</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#657089;--line:#dfe5ef;--blue:#315bd6;--good:#087a55;--warn:#a45b08;--bad:#ba2c2c;--paper:#f5f7fb}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}.shell{max-width:1440px;margin:auto;padding:28px}.hero,.panel,.page-audit{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 30px #2434580d}.hero{padding:32px;margin-bottom:20px;background:linear-gradient(135deg,#fff,#eef3ff)}h1{font-size:clamp(27px,4vw,45px);line-height:1.12;margin:7px 0 12px}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.08em}.lede{max-width:940px;font-size:17px}.scope{display:inline-flex;background:#e8f8f1;color:#086445;border:1px solid #a8dec9;border-radius:999px;padding:7px 12px;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px;margin-top:24px}.metric{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}.metric strong{display:block;font-size:25px}.metric span{color:var(--muted)}.panel{padding:24px;margin:20px 0}h2{margin:0 0 13px;font-size:24px}h3{margin:16px 0 8px}.callout{padding:14px 16px;border-left:4px solid var(--good);background:#edf9f4;border-radius:8px}.bad-callout{border-color:var(--bad);background:#fff1f1}.controls{position:sticky;top:0;z-index:10;background:#f5f7fbeb;backdrop-filter:blur(10px);padding:10px 0;display:flex;gap:8px;flex-wrap:wrap}.controls input{flex:1;min-width:220px;border:1px solid #aeb9cc;border-radius:9px;padding:10px 12px}.controls button{border:1px solid #aeb9cc;background:#fff;border-radius:9px;padding:9px 12px;cursor:pointer}table{width:100%;border-collapse:collapse;overflow:hidden}th,td{border-bottom:1px solid var(--line);padding:9px;text-align:left;vertical-align:top}th{background:#f4f6fa}.changed-grid,.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:13px}.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}.crop-card.changed{border:3px solid #10a575}.crop-card.geometry{box-shadow:inset 0 0 0 2px #e5a22a}.crop-image{display:flex;align-items:center;justify-content:center;min-height:180px;background:#eef1f6;padding:8px}.crop-image img{display:block;max-width:100%;max-height:560px;object-fit:contain}.crop-copy{padding:12px}.crop-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.source{min-height:2.5em;word-break:break-word}.pill{display:inline-block;border-radius:999px;padding:2px 7px;font-size:12px;font-weight:800}.pill.good{color:#06734f;background:#dff7ed}.pill.warn{color:#915008;background:#fff0d6}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:8px 0}dl div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #ccd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.finding{font-size:13px;background:#fff8e8;padding:8px;border-radius:7px}.page-audit{margin:12px 0;overflow:hidden}.page-audit summary{cursor:pointer;padding:16px 20px;display:flex;justify-content:space-between;gap:10px;background:#fff;font-size:16px}.page-audit[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:16px 20px 0;padding:10px 12px;background:#f4f7ff;border-radius:8px}.page-audit figure{margin:18px auto;max-width:1000px;padding:0 20px}.page-audit figure img{display:block;max-width:100%;max-height:900px;margin:auto}.page-audit figcaption{text-align:center;color:var(--muted);margin-top:7px}.page-audit .crop-grid{padding:0 20px 22px}.diagnostic{display:grid;grid-template-columns:minmax(220px,420px) 1fr;gap:20px;align-items:center}.diagnostic img{max-width:100%;max-height:560px}.muted{color:var(--muted)}code{background:#eef1f6;padding:2px 5px;border-radius:5px}@media(max-width:820px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.diagnostic{grid-template-columns:1fr}.page-audit summary{padding:13px}.crop-grid,.changed-grid{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
</style></head><body><main class="shell">
<section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 002</div><h1>TENSEI RENKIN SHOUJO NO SLOW LIFE · Chapter 2</h1><div class="scope">일반 대사/텍스트만 평가 · 효과음 52개 완전 제외</div><p class="lede">HayaiOCR(CUDA/cu126)로 고정한 32페이지의 일반 텍스트 297개를 전체 페이지와 bbox별 확대 crop으로 모두 확인했습니다. 실험 1의 component-first 경로는 폐기했고, 실험 2의 세 방향 geometry 합의만 앱 기본 경로에 승격했습니다.</p><div class="metrics"><div class="metric"><strong>32 / 32</strong><span>전체 페이지 감사</span></div><div class="metric"><strong>297 / 297</strong><span>일반 텍스트 확대 감사</span></div><div class="metric"><strong>277 → 278</strong><span>측정 가능 대사</span></div><div class="metric"><strong>0.1543 → 0.1340</strong><span>같은 글꼴 불일치</span></div><div class="metric"><strong>0</strong><span>작은 글자 퇴행</span></div></div></section>

<section class="panel"><h2>결론 · 내부 버전 fsai-lab-v0.2.0</h2><p class="callout"><strong>승격:</strong> dominant projection, connected-component face, 쓰기 축 glyph pitch가 보수적으로 합의할 때만 기존 추정치를 교정합니다. 새 화에서 6개 일반 대사가 명확히 개선됐고, 이전 화 258개 회귀 지표는 v0.1.1과 정확히 같았습니다.</p><p class="callout bad-callout"><strong>반복 금지:</strong> component와 major 값이 1.30배 안이라는 이유만으로 상향 보정하지 않습니다. 그 조합은 이전 화의 정상 대사 2개를 크게 키웠습니다. 상향은 독립값 비율 ≤1.12와 projection line-fill &lt;0.55를 함께 요구합니다.</p><table><thead><tr><th>비교</th><th>coverage</th><th>같은 글꼴 score</th><th>그룹 coverage</th><th>작은 글자 penalty</th></tr></thead><tbody><tr><td>v0.1.1 projection</td><td>${fmt(projection.summary.coverage)}</td><td>${fmt(projection.summary.sameFontGroupScore)}</td><td>${fmt(projection.summary.sameFontMeanCoverage)}</td><td>${fmt(projection.summary.smallTextRegressionPenalty)}</td></tr><tr><td>v0.2.0 세 방향 합의</td><td>${fmt(finalEvaluation.summary.coverage)}</td><td>${fmt(finalEvaluation.summary.sameFontGroupScore)}</td><td>${fmt(finalEvaluation.summary.sameFontMeanCoverage)}</td><td>${fmt(finalEvaluation.summary.smallTextRegressionPenalty)}</td></tr><tr><td>캠페인 001 회귀</td><td>${fmt(campaignOneRegression.summary.coverage)}</td><td>${fmt(campaignOneRegression.summary.sameFontGroupScore)}</td><td>${fmt(campaignOneRegression.summary.sameFontMeanCoverage)}</td><td>${fmt(campaignOneRegression.summary.smallTextRegressionPenalty)}</td></tr></tbody></table></section>

<section class="panel"><h2>실제로 바뀐 일반 대사 6개</h2><p class="muted">초록 테두리는 v0.2.0이 바꾼 crop입니다. 모든 crop은 원본 해상도로 이웃 본문과 재확인했습니다.</p><div class="changed-grid">${changedCards.join("")}</div></section>

<section class="panel"><h2>bbox 감사 결과</h2><p>효과음 box는 판정하지 않았습니다. 아래는 일반 텍스트에서 남은 구조적 bbox 사례이며, threshold-only 분할을 넣으면 과거 중복 과분할을 반복할 수 있어 이번 글자 크기 승격과 분리했습니다.</p><table><thead><tr><th>페이지</th><th>후보</th><th>심각도</th><th>종류</th><th>판정</th></tr></thead><tbody>${geometryRows}</tbody></table></section>

<section class="panel"><h2>잠긴 같은 글꼴 비교군</h2><table><thead><tr><th>그룹</th><th>페이지</th><th>후보 수</th><th>v0.2.0 score</th><th>coverage</th><th>육안 기준</th></tr></thead><tbody>${sameFontRows}</tbody></table></section>

<section class="panel diagnostic"><div>${imageTag(fixedDiagnostic, "사용자가 발견한 좁고 긴 세로 원문 실패")}</div><div><h2>고정 진단도 함께 보존</h2><p><code>神の慈悲により → 신의 자비로</code>는 실험 화가 아니라 사용자 고정 진단입니다. 완전 누락된 source face를 같은 방향·역할·굵기의 신뢰 peer 중앙값으로 복구해 실제 렌더가 <strong>12px → 21px</strong>로 회복됐습니다. 세 방향 합의가 이 보수적 fallback을 덮어쓰지 않는 것도 회귀 테스트로 잠갔습니다.</p></div></section>

<div class="controls"><input id="search" placeholder="P018/D003, OCR 문자열, vertical 검색"><button data-open>모든 페이지 열기</button><button data-close>모든 페이지 닫기</button></div>
<section id="pages"><h2>32페이지 · 일반 대사 297개 전체 감사</h2>${pageSections.join("")}</section>
<p class="muted">생성 ${escapeHtml(generatedAt)} · 봉인 seed ${escapeHtml(selection.seed)} · 이미지 ${Object.keys(imageData).length}개 내장 · 외부 파일 없이 열리는 self-contained HTML</p>
</main><script id="image-data" type="application/json">${imageJson}</script><script>(()=>{const data=JSON.parse(document.getElementById('image-data').textContent);const load=i=>{if(!i.src)i.src=data[i.dataset.image]};if('IntersectionObserver'in window){const o=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){load(e.target);o.unobserve(e.target)}}),{rootMargin:'1000px'});document.querySelectorAll('img[data-image]').forEach(i=>o.observe(i))}else document.querySelectorAll('img[data-image]').forEach(load);document.querySelector('[data-open]').onclick=()=>document.querySelectorAll('.page-audit').forEach(x=>x.open=true);document.querySelector('[data-close]').onclick=()=>document.querySelectorAll('.page-audit').forEach(x=>x.open=false);const search=document.getElementById('search');search.oninput=()=>{const q=search.value.trim().toLocaleLowerCase('ko-KR');document.querySelectorAll('.page-audit').forEach(page=>{let n=0;page.querySelectorAll('.crop-card').forEach(card=>{const yes=!q||card.dataset.search.includes(q);card.style.display=yes?'':'none';if(yes)n++});page.style.display=n?'':'none';if(q&&n)page.open=true})}})();</script></body></html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const bytes = fs.readFileSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    output: path.relative(repoRoot, outputPath).replaceAll("\\", "/"),
    byteSize: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    embeddedImageCount: Object.keys(imageData).length,
    encodedImageBytes,
    pageCount: baselineReport.summary.pageCount,
    dialogueCount: baselineReport.summary.dialogueCount,
    dialogueCropsReviewed: audit.coverage.dialogueCropsReviewed,
    effectCountExcluded: baselineReport.summary.effectCount,
    internalVersion: verdict.internalVersion,
  };
  const manifestPath = path.join(campaignRoot, "chapter-report.manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        ...manifest,
        manifest: path.relative(repoRoot, manifestPath).replaceAll("\\", "/"),
      },
      null,
      2,
    ),
  );
}

const args = parseArgs(process.argv.slice(2));
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(() => buildReport(args.output))
  .then(() => app.quit())
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });

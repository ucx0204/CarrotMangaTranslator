#!/usr/bin/env electron
/* eslint-disable -- isolated self-contained visual audit report generator */
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
  "campaign-003",
);
const baselineRoot = path.join(campaignRoot, "exp-01-v0.2.0-baseline");
const rawLatticeRoot = path.join(
  campaignRoot,
  "exp-02-cross-hypothesis-lattice",
);
const peerLatticeRoot = path.join(
  campaignRoot,
  "exp-03-peer-gated-hypothesis-lattice",
);
const productRoot = path.join(campaignRoot, "exp-04-production-peer-gated");
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/build-campaign-003-report.cjs " +
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

function candidateMap(report) {
  const result = new Map();
  for (const page of report.pages) {
    for (const candidate of page.candidates) {
      result.set(candidateKey(page.pageId, candidate.candidateId), candidate);
    }
  }
  return result;
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

function registerPath(filePath, maxWidth = 760, quality = 91) {
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
  for (const candidate of page.candidates) drawRectangle(png, candidate.bbox);
  return registerNativeImage(
    nativeImage.createFromBuffer(PNG.sync.write(png)),
    980,
    87,
  );
}

function imageTag(key, alt) {
  return `<img data-image="${escapeHtml(key)}" alt="${escapeHtml(
    alt,
  )}" loading="lazy" decoding="async">`;
}

function findingMap(items) {
  return new Map(
    items.map((item) => [candidateKey(item.pageId, item.candidateId), item]),
  );
}

function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const baselineReport = readJson(
    path.join(baselineRoot, "baseline-report.json"),
  );
  const productReport = readJson(
    path.join(productRoot, "baseline-report.json"),
  );
  const audit = readJson(path.join(campaignRoot, "visual-audit.json"));
  const rawLattice = readJson(path.join(rawLatticeRoot, "evaluation.json"));
  const peerLattice = readJson(path.join(peerLatticeRoot, "evaluation.json"));
  const productEvaluation = readJson(path.join(productRoot, "evaluation.json"));
  const regressionOne = readJson(
    path.join(productRoot, "campaign-001-product-regression.json"),
  );
  const regressionTwo = readJson(
    path.join(productRoot, "campaign-002-product-regression.json"),
  );
  const verdict = readJson(path.join(productRoot, "verdict.json"));

  const beforeById = candidateMap(baselineReport);
  const changedById = new Map(
    productEvaluation.changed.map((item) => [item.id, item]),
  );
  const sizeFindingById = findingMap(audit.fontSizeFindings);
  const geometryById = findingMap(audit.dialogueGeometryFindings);
  const pageNotes = new Map(
    audit.pageLevelNotes.map((item) => [item.pageId, item.note]),
  );
  const changedCards = [];
  const pageSections = [];

  for (const page of productReport.pages) {
    const overlayKey = registerDialogueOverlay(page);
    const cards = [];
    for (const candidate of page.candidates) {
      const id = candidateKey(page.pageId, candidate.candidateId);
      const before = beforeById.get(id)?.estimate ?? null;
      const after = candidate.estimate ?? null;
      const changed = changedById.get(id);
      const sizeFinding = sizeFindingById.get(id);
      const geometry = geometryById.get(id);
      const cropKey = registerPath(path.join(productRoot, candidate.cropPath));
      const bbox = candidate.bbox;
      const card = `<article class="crop-card ${changed ? "changed" : ""} ${
        geometry ? "geometry" : ""
      }" data-search="${escapeHtml(
        `${id} ${candidate.sourceText} ${candidate.direction}`.toLocaleLowerCase(
          "ko-KR",
        ),
      )}">
        <div class="crop-image">${imageTag(cropKey, `${id} 실제 bbox 확대`)}</div>
        <div class="crop-copy"><div class="crop-title"><strong>${escapeHtml(
          id,
        )}</strong>${
          changed ? '<span class="pill good">제품 개선</span>' : ""
        }</div><p class="source">${escapeHtml(
          candidate.sourceText || "OCR 문자열 없음",
        )}</p><dl>
          <div><dt>방향</dt><dd>${escapeHtml(candidate.direction)}</dd></div>
          <div><dt>Hayai</dt><dd>${fmt(candidate.hayaiConfidence)}</dd></div>
          <div><dt>bbox</dt><dd>${fmt(bbox.x2 - bbox.x1, 0)}×${fmt(
            bbox.y2 - bbox.y1,
            0,
          )}</dd></div>
          <div><dt>기존</dt><dd>${before ? `${fmt(before.facePx)}px` : "abstain"}</dd></div>
          <div><dt>v0.3.0</dt><dd>${after ? `${fmt(after.facePx)}px` : "abstain"}</dd></div>
          <div><dt>신뢰도</dt><dd>${fmt(after?.confidence)}</dd></div>
        </dl>${
          sizeFinding
            ? `<p class="finding"><strong>크기 감사:</strong> ${escapeHtml(
                sizeFinding.note,
              )}</p>`
            : ""
        }${
          geometry
            ? `<p class="finding"><strong>bbox 감사:</strong> ${escapeHtml(
                geometry.note,
              )} <span class="pill warn">${escapeHtml(geometry.severity)}</span></p>`
            : ""
        }</div></article>`;
      cards.push(card);
      if (changed) changedCards.push(card);
    }
    const containsChange = page.candidates.some((candidate) =>
      changedById.has(candidateKey(page.pageId, candidate.candidateId)),
    );
    pageSections.push(`<details class="page-audit" ${containsChange ? "open" : ""}>
      <summary><span><strong>${page.pageId}</strong> · ${escapeHtml(
        page.name,
      )}</span><span>${page.dialogueCount}개 일반 텍스트</span></summary>
      <div class="page-note">${escapeHtml(
        pageNotes.get(page.pageId) ?? "특기할 일반 텍스트 문제 없음",
      )}</div>
      <figure>${imageTag(
        overlayKey,
        `${page.pageId} 일반 대사 전용 전체 오버레이`,
      )}<figcaption>빨간 사각형은 일반 대사/텍스트만 표시합니다. 효과음은 표시·평가하지 않았습니다.</figcaption></figure>
      <div class="crop-grid">${cards.join("")}</div>
    </details>`);
  }

  const geometryRows = audit.dialogueGeometryFindings
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.pageId)}</td><td>${escapeHtml(
          item.candidateId,
        )}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.note)}</td></tr>`,
    )
    .join("");
  const sameFontRows = audit.sameVisualFontGroups
    .map((group) => {
      const result = productEvaluation.candidateScores.groups.find(
        (item) => item.id === group.id,
      );
      return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(
        group.pageId,
      )}</td><td>${group.candidateIds.length}</td><td>${fmt(
        result?.score,
      )}</td><td>${escapeHtml(group.judgement)}</td></tr>`;
    })
    .join("");

  const expectedImageCount =
    productReport.summary.pageCount + productReport.summary.dialogueCount;
  if (Object.keys(imageData).length !== expectedImageCount) {
    throw new Error(
      `Embedded image count mismatch: ${Object.keys(imageData).length} != ${expectedImageCount}`,
    );
  }
  const generatedAt = new Date().toISOString();
  const imageJson = JSON.stringify(imageData).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>글자 크기 AI 캠페인 003 · Chapter 4</title><style>
:root{color-scheme:light;--ink:#172033;--muted:#657089;--line:#dfe5ef;--blue:#315bd6;--good:#087a55;--warn:#a45b08;--bad:#ba2c2c;--paper:#f5f7fb}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}.shell{max-width:1440px;margin:auto;padding:28px;min-width:0}.hero,.panel,.page-audit{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 30px #2434580d;min-width:0}.hero{padding:32px;margin-bottom:20px;background:linear-gradient(135deg,#fff,#eef3ff)}h1{font-size:clamp(27px,4vw,45px);line-height:1.12;margin:7px 0 12px}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.08em}.lede{max-width:1000px;font-size:17px}.scope{display:inline-flex;background:#e8f8f1;color:#086445;border:1px solid #a8dec9;border-radius:999px;padding:7px 12px;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px;margin-top:24px}.metric{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}.metric strong{display:block;font-size:25px}.metric span{color:var(--muted)}.panel{padding:24px;margin:20px 0}h2{margin:0 0 13px;font-size:24px}.callout{padding:14px 16px;border-left:4px solid var(--good);background:#edf9f4;border-radius:8px}.bad-callout{border-color:var(--bad);background:#fff1f1}.warn-callout{border-color:var(--warn);background:#fff8e8}.controls{position:sticky;top:0;z-index:10;background:#f5f7fbeb;backdrop-filter:blur(10px);padding:10px 0;display:flex;gap:8px;flex-wrap:wrap}.controls input{flex:1;min-width:220px;border:1px solid #aeb9cc;border-radius:9px;padding:10px 12px}.controls button{border:1px solid #aeb9cc;background:#fff;border-radius:9px;padding:9px 12px;cursor:pointer}table{width:100%;max-width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:9px;text-align:left;vertical-align:top}th{background:#f4f6fa}.changed-grid,.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:13px}.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}.crop-card.changed{border:3px solid #10a575}.crop-card.geometry{box-shadow:inset 0 0 0 2px #e5a22a}.crop-image{display:flex;align-items:center;justify-content:center;min-height:180px;background:#eef1f6;padding:8px}.crop-image img{display:block;max-width:100%;max-height:560px;object-fit:contain}.crop-copy{padding:12px}.crop-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.source{min-height:2.5em;word-break:break-word}.pill{display:inline-block;border-radius:999px;padding:2px 7px;font-size:12px;font-weight:800}.pill.good{color:#06734f;background:#dff7ed}.pill.warn{color:#915008;background:#fff0d6}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:8px 0}dl div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #ccd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.finding{font-size:13px;background:#fff8e8;padding:8px;border-radius:7px}.page-audit{margin:12px 0;overflow:hidden}.page-audit summary{cursor:pointer;padding:16px 20px;display:flex;justify-content:space-between;gap:10px;background:#fff;font-size:16px}.page-audit[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:16px 20px 0;padding:10px 12px;background:#f4f7ff;border-radius:8px}.page-audit figure{margin:18px auto;max-width:1000px;padding:0 20px}.page-audit figure img{display:block;max-width:100%;max-height:900px;margin:auto}.page-audit figcaption{text-align:center;color:var(--muted);margin-top:7px}.page-audit .crop-grid{padding:0 20px 22px}.muted{color:var(--muted)}code{background:#eef1f6;padding:2px 5px;border-radius:5px}@media(max-width:820px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.page-audit summary{padding:13px}.crop-grid,.changed-grid{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
</style></head><body><main class="shell">
<section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 003</div><h1>Isekai Tensei Reijou, Shuppon Suru · Chapter 4</h1><div class="scope">HayaiOCR 고정 · 일반 대사 151개 · 효과음 42개 완전 제외</div><p class="lede">21페이지 전체 오버레이와 일반 대사 bbox 151개를 각각 원본 확대 확인했습니다. 무조건 페이지 평균으로 맞추지 않고, 후보 자체에서 반복되는 낮은 글자 크기 증거가 있으면서 정상 peer 군집이 안정적일 때만 높은 오추정을 교정했습니다.</p><div class="metrics"><div class="metric"><strong>21 / 21</strong><span>전체 페이지 감사</span></div><div class="metric"><strong>151 / 151</strong><span>bbox 개별 확대 감사</span></div><div class="metric"><strong>146 → 146</strong><span>coverage 유지</span></div><div class="metric"><strong>0.0919 → 0.0604</strong><span>같은 글꼴 불일치</span></div><div class="metric"><strong>0 / 555</strong><span>과거 예상값 불일치</span></div></div></section>

<section class="panel"><h2>결론 · 내부 버전 ${escapeHtml(
    verdict.internalVersion,
  )}</h2><p class="callout"><strong>제품 승격:</strong> 실제 제품 페이지 추정기로 151개를 다시 계산해 실험 결과와 전부 일치했습니다. 높은 오추정 6개를 낮췄고, 작은 글자·큰 강조 글자 hierarchy penalty는 0을 유지했습니다.</p><p class="callout warn-callout"><strong>보수적 미교정:</strong> P008/D001은 여전히 36.1719px입니다. peer만 보고 값을 복사하지 않기 때문에 후보 자체의 반복된 낮은 모드가 부족한 이 사례는 강제로 고치지 않았습니다.</p><p class="callout bad-callout"><strong>반복 금지:</strong> 실험 2의 gate 없는 lattice는 정상 본문까지 21개를 줄여 같은 글꼴 score를 0.0919에서 0.0962로 악화시켰습니다. 안정 peer와 독립적인 후보 자체 증거 없이 재사용하지 않습니다.</p></section>

<section class="panel"><h2>4회 실험 기록</h2><table><thead><tr><th>회차</th><th>변경</th><th>coverage</th><th>같은 글꼴 score</th><th>판정</th></tr></thead><tbody><tr><td>1 · v0.2.x 기준선</td><td>—</td><td>${fmt(
    baselineReport.summary.estimatedCount /
      baselineReport.summary.dialogueCount,
  )}</td><td>${fmt(peerLattice.summary.baselineSameFontGroupScore)}</td><td>151개 육안 감사 기준선</td></tr><tr><td>2 · raw cross-hypothesis lattice</td><td>${rawLattice.summary.changedCount}</td><td>${fmt(
    rawLattice.summary.coverage,
  )}</td><td>${fmt(rawLattice.summary.sameFontGroupScore)}</td><td>폐기 · 정상 본문 과축소</td></tr><tr><td>3 · peer-gated lattice</td><td>${peerLattice.summary.changedCount}</td><td>${fmt(
    peerLattice.summary.coverage,
  )}</td><td>${fmt(peerLattice.summary.sameFontGroupScore)}</td><td>육안·지표 통과</td></tr><tr><td>4 · 실제 제품 재실행</td><td>${productEvaluation.summary.changedCount}</td><td>${fmt(
    productEvaluation.summary.estimated /
      productEvaluation.summary.candidateCount,
  )}</td><td>${fmt(productEvaluation.summary.sameFontGroupScore)}</td><td>실험 예상/증거 mismatch 0 · 승격</td></tr></tbody></table></section>

<section class="panel"><h2>실제로 개선된 6개</h2><p class="muted">초록 테두리는 제품 출력이 바뀐 실제 bbox crop입니다. bbox가 잘못 병합된 경우는 크기 개선과 구조적 문제가 동시에 표기됩니다.</p><div class="changed-grid">${changedCards.join(
    "",
  )}</div></section>

<section class="panel"><h2>과거 화 회귀 잠금</h2><p>Campaign 001의 258개와 Campaign 002의 297개를 현재 빌드로 재생했습니다. 두 화 모두 잠긴 현재 예상값과 불일치 0개이고, 이번 peer gate가 추가로 건드린 후보도 0개입니다.</p><table><thead><tr><th>화</th><th>후보</th><th>현재 예상 mismatch</th><th>peer-gate 신규 변경</th></tr></thead><tbody><tr><td>Campaign 001</td><td>${regressionOne.summary.candidateCount}</td><td>${regressionOne.summary.expectedPredictionMismatchCount}</td><td>${regressionOne.summary.expectedRuleChangedCount}</td></tr><tr><td>Campaign 002</td><td>${regressionTwo.summary.candidateCount}</td><td>${regressionTwo.summary.expectedPredictionMismatchCount}</td><td>${regressionTwo.summary.expectedRuleChangedCount}</td></tr></tbody></table><p class="muted">Campaign 002의 최초 source report는 v0.2.1 이전 자료라 현재 제품과 역사적 차이가 있습니다. 위 표는 그 옛 파일이 아니라 잠긴 현재 제품 예상값과 비교한 결과입니다.</p></section>

<section class="panel"><h2>남은 일반 대사 bbox 문제</h2><p>효과음 box는 사용자가 따로 선택하는 흐름이므로 전부 무시했습니다. 아래 구조 문제는 폰트 크기 보정으로 숨기지 않고 다음 detector/containment 회귀 대상으로 잠갔습니다.</p><table><thead><tr><th>페이지</th><th>후보</th><th>종류</th><th>판정</th></tr></thead><tbody>${geometryRows}</tbody></table></section>

<section class="panel"><h2>같은 글꼴 비교군</h2><table><thead><tr><th>그룹</th><th>페이지</th><th>후보</th><th>v0.3.0 score</th><th>육안 기준</th></tr></thead><tbody>${sameFontRows}</tbody></table></section>

<div class="controls"><input id="search" placeholder="P010/D006, OCR 문자열, vertical 검색"><button data-open>모든 페이지 열기</button><button data-close>모든 페이지 닫기</button></div><section id="pages"><h2>21페이지 · 일반 대사 151개 전체 감사</h2>${pageSections.join(
    "",
  )}</section><p class="muted">생성 ${escapeHtml(generatedAt)} · 봉인 seed ${escapeHtml(
    selection.seed,
  )} · 이미지 ${Object.keys(imageData).length}개 내장 · 외부 파일 없이 열리는 self-contained HTML</p>
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
    pageCount: productReport.summary.pageCount,
    dialogueCount: productReport.summary.dialogueCount,
    dialogueCropsReviewed: audit.coverage.dialogueCropsReviewed,
    effectCountExcluded: productReport.summary.effectCount,
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

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
  "campaign-004",
);
const baselineRoot = path.join(campaignRoot, "exp-01-v0.3.0-baseline");
const productRoot = path.join(
  campaignRoot,
  "exp-02-peer-gated-upward-mode-hayai",
);
const defaultOutput = path.join(campaignRoot, "chapter-report.html");

function parseArgs(argv) {
  let output = defaultOutput;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/build-campaign-004-report.cjs " +
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
  return new Map(
    report.pages.flatMap((page) =>
      page.candidates.map((candidate) => [
        candidateKey(page.pageId, candidate.candidateId),
        candidate,
      ]),
    ),
  );
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
  return `<img src="${imageDataUri(filePath, maxWidth, quality)}" alt="${escapeHtml(
    alt,
  )}" loading="lazy" decoding="async">`;
}

function findingMap(items) {
  return new Map(
    items.map((item) => [candidateKey(item.pageId, item.candidateId), item]),
  );
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
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
  const sizeFindingById = findingMap(audit.fontSizeFindings);
  const geometryById = findingMap(audit.dialogueGeometryFindings);
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
      const bbox = candidate.bbox;
      const card = `<article class="crop-card ${changed ? "changed" : ""} ${
        geometry ? "geometry" : ""
      }" data-search="${escapeHtml(
        `${id} ${candidate.sourceText} ${candidate.direction}`.toLocaleLowerCase(
          "ko-KR",
        ),
      )}">
        <div class="crop-image">${imageTag(
          path.join(productRoot, candidate.cropPath),
          `${id} 실제 bbox 확대`,
        )}</div>
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
          <div><dt>v0.3.0</dt><dd>${before ? `${fmt(before.facePx)}px` : "abstain"}</dd></div>
          <div><dt>v0.4.0</dt><dd>${after ? `${fmt(after.facePx)}px` : "abstain"}</dd></div>
          <div><dt>신뢰도</dt><dd>${fmt(after?.confidence)}</dd></div>
        </dl>${
          sizeFinding
            ? `<p class="finding"><strong>크기 감사:</strong> ${escapeHtml(
                sizeFinding.note,
              )}</p>`
            : ""
        }${
          geometry
            ? `<p class="finding geometry-copy"><strong>bbox 감사:</strong> ${escapeHtml(
                geometry.note,
              )}</p>`
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
      <p class="page-note">${escapeHtml(
        pageNotes.get(page.pageId) ?? "특기할 일반 텍스트 문제 없음",
      )}</p>
      <figure>${imageTag(
        path.join(productRoot, page.overlayPath),
        `${page.pageId} 실제 HayaiOCR bbox 오버레이`,
        980,
        87,
      )}<figcaption>빨강은 일반 대사, 파랑은 효과음 후보입니다. 파랑 4개는 사용자 지시에 따라 판정·점수·수정에서 완전히 제외했습니다.</figcaption></figure>
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

  const geometryRows = audit.dialogueGeometryFindings
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.pageId)}/${escapeHtml(
          item.candidateId,
        )}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(
          item.severity,
        )}</td><td>${escapeHtml(item.note)}</td></tr>`,
    )
    .join("");
  const findingRows = audit.fontSizeFindings
    .map((item) => {
      const id = candidateKey(item.pageId, item.candidateId);
      const changed = changedById.get(id);
      return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(
        item.severity,
      )}</td><td>${fmt(item.baselineFacePx)}px</td><td>${
        changed ? `${fmt(changed.after.facePx)}px` : "유지/이월"
      }</td><td>${escapeHtml(item.note)}</td></tr>`;
    })
    .join("");
  const deadEnds = audit.diagnosticDeadEnds
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.hypothesis)}</strong><br>${escapeHtml(
          item.result,
        )} <span class="pill bad">${escapeHtml(item.decision)}</span></li>`,
    )
    .join("");
  const prior = verdict.priorCampaignReplay;
  const generatedAt = new Date().toISOString();
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>글자 크기 AI 캠페인 004 · Chapter 13.2</title><style>
:root{color-scheme:light;--ink:#172033;--muted:#657089;--line:#dfe5ef;--blue:#315bd6;--good:#087a55;--warn:#a45b08;--bad:#ba2c2c;--paper:#f5f7fb}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}.shell{max-width:1440px;margin:auto;padding:28px;min-width:0}.hero,.panel,.page-audit{background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 30px #2434580d;min-width:0}.hero{padding:32px;margin-bottom:20px;background:linear-gradient(135deg,#fff,#eef3ff)}h1{font-size:clamp(27px,4vw,45px);line-height:1.12;margin:7px 0 12px}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.08em}.lede{max-width:1050px;font-size:17px}.scope{display:inline-flex;background:#e8f8f1;color:#086445;border:1px solid #a8dec9;border-radius:999px;padding:7px 12px;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px;margin-top:24px}.metric{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}.metric strong{display:block;font-size:25px}.metric span{color:var(--muted)}.panel{padding:24px;margin:20px 0}h2{margin:0 0 13px;font-size:24px}.callout{padding:14px 16px;border-left:4px solid var(--good);background:#edf9f4;border-radius:8px}.warn-callout{border-color:var(--warn);background:#fff8e8}.bad-callout{border-color:var(--bad);background:#fff1f1}.controls{position:sticky;top:0;z-index:10;background:#f5f7fbeb;backdrop-filter:blur(10px);padding:10px 0;display:flex;gap:8px;flex-wrap:wrap}.controls input{flex:1;min-width:220px;border:1px solid #aeb9cc;border-radius:9px;padding:10px 12px}.controls button{border:1px solid #aeb9cc;background:#fff;border-radius:9px;padding:9px 12px;cursor:pointer}table{width:100%;max-width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:9px;text-align:left;vertical-align:top}th{background:#f4f6fa}.changed-grid,.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:13px}.crop-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;min-width:0}.crop-card.changed{border:3px solid #10a575}.crop-card.geometry{box-shadow:inset 0 0 0 2px #e5a22a}.crop-image{display:flex;align-items:center;justify-content:center;min-height:180px;background:#eef1f6;padding:8px}.crop-image img{display:block;max-width:100%;max-height:560px;object-fit:contain}.crop-copy{padding:12px}.crop-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.source{min-height:2.5em;word-break:break-word}.pill{display:inline-block;border-radius:999px;padding:2px 7px;font-size:12px;font-weight:800}.pill.good{color:#06734f;background:#dff7ed}.pill.bad{color:#9d2323;background:#ffe2e2}dl{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:8px 0}dl div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #ccd3df}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}.finding{font-size:13px;background:#fff8e8;padding:8px;border-radius:7px}.geometry-copy{background:#fff0d6}.page-audit{margin:12px 0;overflow:hidden}.page-audit summary{cursor:pointer;padding:16px 20px;display:flex;justify-content:space-between;gap:10px;background:#fff;font-size:16px}.page-audit[open] summary{border-bottom:1px solid var(--line)}.page-note{margin:16px 20px 0;padding:10px 12px;background:#f4f7ff;border-radius:8px}.page-audit figure{margin:18px auto;max-width:1000px;padding:0 20px}.page-audit figure img{display:block;max-width:100%;max-height:900px;margin:auto}.page-audit figcaption{text-align:center;color:var(--muted);margin-top:7px}.page-audit .crop-grid{padding:0 20px 22px}.muted{color:var(--muted)}ul li{margin:9px 0}@media(max-width:820px){.shell{padding:12px}.hero,.panel{padding:18px}.metrics{grid-template-columns:1fr 1fr}.page-audit summary{padding:13px}.crop-grid,.changed-grid{grid-template-columns:1fr}table{display:block;overflow-x:auto}}@media(max-width:430px){.metrics{grid-template-columns:1fr}.controls input{min-width:100%}}
</style></head><body><main class="shell">
<section class="hero"><div class="eyebrow">FONT SIZE AI LAB · CAMPAIGN 004</div><h1>Saijaku Kizoku… · Chapter 13.2</h1><div class="scope">HayaiOCR 고정 · 일반 대사 70개 · 효과음 4개 완전 제외</div><p class="lede">봉인된 미사용 화의 10페이지 전체와 일반 대사 bbox 70개를 각각 원본 해상도로 확대 감사했습니다. 이번 승격은 페이지 평균을 복사하지 않습니다. 낮게 측정된 후보 자체에서 component와 major-axis 증거가 반복되고, 안정적인 같은 페이지 본문 tier가 이를 허용할 때만 후보 자신의 픽셀 모드로 올립니다.</p><div class="metrics"><div class="metric"><strong>10 / 10</strong><span>전체 페이지 감사</span></div><div class="metric"><strong>70 / 70</strong><span>bbox 개별 확대</span></div><div class="metric"><strong>65 → 65</strong><span>coverage 유지</span></div><div class="metric"><strong>0.1178 → 0.1124</strong><span>같은 글꼴 불일치</span></div><div class="metric"><strong>0 / 706</strong><span>과거 예상값 불일치</span></div></div></section>

<section class="panel"><h2>결론 · 내부 버전 ${escapeHtml(
    verdict.internalVersion,
  )}</h2><p class="callout"><strong>승격:</strong> P008/D002가 자신의 반복 픽셀 증거로 18.4736px에서 21.522px로 회복됐습니다. 실제 CUDA/cu126 HayaiOCR 재실행은 사전 예측과 70/70 일치했고, OCR 증거 불일치도 0입니다.</p><p class="callout warn-callout"><strong>유지:</strong> P005/D003은 가로 23.7636px, 세로 24.50px로 방향만 바꿔서는 해결되지 않았습니다. P009/D008의 높은 다열 오차와 P004/D001-D002의 겹친 bbox는 별도 가설로 이월합니다.</p><p class="callout bad-callout"><strong>반복 금지:</strong> near-square 박스를 전부 세로로 뒤집거나 page median을 직접 복사하지 않습니다. 실제 작은 글씨·큰 강조 계층을 평준화할 수 있기 때문입니다.</p></section>

<section class="panel"><h2>실험 기록</h2><table><thead><tr><th>회차</th><th>가설</th><th>결과</th><th>판정</th></tr></thead><tbody><tr><td>1</td><td>v0.3.0 실제 HayaiOCR 기준선</td><td>70개 중 65개 추정, 전 crop 감사</td><td>문제 봉인</td></tr><tr><td>진단</td><td>near-square 방향 반전</td><td>P005/D003 +0.74px뿐, P004/D002는 -7.05px 위험</td><td>전역 규칙 기각</td></tr><tr><td>2</td><td>peer-gated candidate-owned upward mode</td><td>1개 개선, score 0.1178→0.1124, hierarchy penalty 0</td><td>v0.4.0 승격</td></tr></tbody></table></section>

<section class="panel"><h2>이번에 실제로 바뀐 bbox</h2><div class="changed-grid">${changedCards.join(
    "",
  )}</div></section>

<section class="panel"><h2>과거 화 회귀 재생</h2><table><thead><tr><th>화</th><th>후보</th><th>새 개선</th><th>같은 글꼴 score</th><th>예상 불일치</th></tr></thead><tbody><tr><td>캠페인 001</td><td>${prior.campaign001.candidateCount}</td><td>${prior.campaign001.changedCount}</td><td>0.0994 유지</td><td>0</td></tr><tr><td>캠페인 002</td><td>${prior.campaign002.candidateCount}</td><td>${prior.campaign002.changedCount}</td><td>${fmt(
    prior.campaign002.sameFontGroupScoreBefore,
  )}→${fmt(prior.campaign002.sameFontGroupScoreAfter)}</td><td>0</td></tr><tr><td>캠페인 003</td><td>${prior.campaign003.candidateCount}</td><td>${prior.campaign003.changedCount}</td><td>0.0604 유지</td><td>0</td></tr></tbody></table></section>

<section class="panel"><h2>글자 크기 감사 판정</h2><table><thead><tr><th>ID</th><th>심각도</th><th>기준</th><th>결과</th><th>판정</th></tr></thead><tbody>${findingRows}</tbody></table></section>
<section class="panel"><h2>일반 대사 bbox 문제</h2><p class="muted">효과음 후보가 아니라 일반 대사 containment/partition 문제만 적었습니다.</p><table><thead><tr><th>ID</th><th>유형</th><th>심각도</th><th>메모</th></tr></thead><tbody>${geometryRows}</tbody></table></section>
<section class="panel"><h2>실패 조합 씨육수</h2><ul>${deadEnds}</ul></section>

<div class="controls"><input id="search" type="search" placeholder="P008/D002 또는 OCR 문자열 검색"><button id="openAll">모든 페이지 펼치기</button><button id="closeAll">모든 페이지 접기</button></div>
<section aria-label="페이지별 전체 감사">${pageSections.join("")}</section>
<footer class="panel muted">봉인 seed: ${escapeHtml(
    selection.seed,
  )}<br>생성: ${escapeHtml(generatedAt)} · self-contained 이미지 ${embeddedPaths.size}개 · 원본 이미지 bytes ${embeddedBytes.toLocaleString("ko-KR")}</footer>
</main><script>
const search=document.getElementById('search');const cards=[...document.querySelectorAll('.crop-card')];search.addEventListener('input',()=>{const q=search.value.trim().toLocaleLowerCase('ko-KR');for(const card of cards)card.hidden=Boolean(q)&&!card.dataset.search.includes(q);});document.getElementById('openAll').onclick=()=>document.querySelectorAll('.page-audit').forEach(x=>x.open=true);document.getElementById('closeAll').onclick=()=>document.querySelectorAll('.page-audit').forEach(x=>x.open=false);
</script></body></html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const htmlBytes = fs.readFileSync(outputPath);
  const manifest = {
    schemaVersion: 1,
    campaign: 4,
    chapterKey: selection.key,
    generatedAt,
    output: path.relative(repoRoot, outputPath).replaceAll("\\", "/"),
    byteSize: htmlBytes.length,
    sha256: sha256Bytes(htmlBytes),
    embeddedImageCount: embeddedPaths.size,
    expectedEmbeddedImageCount: expectedImages,
    sourceImageBytes: embeddedBytes,
    pageCount: product.summary.pageCount,
    dialogueCropCount: product.summary.dialogueCount,
    effectCropCountExcluded: product.summary.effectCount,
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

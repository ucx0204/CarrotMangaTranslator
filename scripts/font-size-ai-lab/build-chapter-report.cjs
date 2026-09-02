#!/usr/bin/env electron
/* eslint-disable -- isolated experiment/audit utility, not a production module */
// @ts-nocheck -- isolated report generator; production types remain checked.
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
  "campaign-001",
);
const hayaiRoot = path.join(campaignRoot, "exp-05-hayai-validation");
const geometryRoot = path.join(
  campaignRoot,
  "exp-05-ownership-robust-bboxes-r2",
);
const defaultOutput = path.join(campaignRoot, "chapter-report.html");
const attachmentPath = path.join(
  "C:\\Users\\sam40\\AppData\\Local\\Temp",
  "codex-clipboard-1a09e7a8-ad03-4125-9f60-1dc6735508b5.png",
);

const experimentSpecs = [
  {
    directory: "exp-01-production-baseline",
    name: "실험 1 · production 기준선",
    verdict: "기준선",
    tone: "neutral",
    finding:
      "다열 영역의 abstain과 패널 횡단 bbox를 재현했다. 제품 개선은 없어 승격하지 않았다.",
  },
  {
    directory: "exp-02-density-valley-bands",
    name: "실험 2 · density-valley band",
    verdict: "부분 성공",
    tone: "warn",
    finding:
      "사용자 고정 사례의 아래 3열을 22.009px로 복구했지만 ruby·crop satellite 오차가 남았다.",
  },
  {
    directory: "exp-03-dense-mass-trim",
    name: "실험 3 · 고정 95% 질량 trim",
    verdict: "기각",
    tone: "bad",
    finding:
      "평균 점수는 좋아졌지만 P013 ruby 혼합이 33.8→41px로 악화됐다. 같은 조합은 반복 금지다.",
  },
  {
    directory: "exp-04-dominant-column-core",
    name: "실험 4 · 85% dominant-column core",
    verdict: "채택",
    tone: "good",
    finding:
      "본문 core와 ruby/satellite를 분리해 같은 글꼴 불일치를 크게 줄이고 실제 작은 글씨를 보존했다.",
  },
  {
    directory: "exp-05-hayai-validation",
    name: "실험 5 · robust bbox + ownership + 실제 HayaiOCR",
    verdict: "승격",
    tone: "good",
    finding:
      "32페이지 CUDA/cu126 완주, 빈 OCR 0, 최종 258개 대사 중 248개 source-face 적용. 내부 v0.1.0으로 조건부 승격했다.",
  },
];

const severeGeometryPages = [
  {
    pageId: "P011",
    old: 0.3654,
    next: 0.033,
    note: "여러 mask의 패널 횡단 union 분리",
  },
  {
    pageId: "P023",
    old: 0.0847,
    next: 0.0302,
    note: "broad sparse T026 거부 + owner 보존",
  },
  {
    pageId: "P024",
    old: null,
    next: null,
    note: "하단 단일 mask 범위 1145px → 933px",
  },
  {
    pageId: "P025",
    old: 0.2771,
    next: 0.0308,
    note: "패널 횡단 union 분리",
  },
  {
    pageId: "P027",
    old: 0.1947,
    next: 0.033,
    note: "패널 횡단 union 분리",
  },
  {
    pageId: "P030",
    old: 0.1583,
    next: 0.0177,
    note: "상단 단일 mask outlier robust trim",
  },
  {
    pageId: "P031",
    old: 0.2168,
    next: 0.018,
    note: "다중 owner가 합쳐진 거대 bbox 분리",
  },
];

function parseArgs(argv) {
  const args = { output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/build-chapter-report.cjs " +
          "[--output PATH]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
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

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  return Number(value).toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "");
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

const imageData = Object.create(null);
const imageCache = new Map();
let encodedSourceBytes = 0;
let encodedImageBytes = 0;

function registerImage(
  filePath,
  { maxWidth = 900, quality = 88, required = true } = {},
) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Report image does not exist: ${filePath}`);
    return null;
  }
  const cacheKey = `${filePath}\0${maxWidth}\0${quality}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;
  const source = fs.readFileSync(filePath);
  let image = nativeImage.createFromBuffer(source);
  if (image.isEmpty())
    throw new Error(`Electron could not decode: ${filePath}`);
  const size = image.getSize();
  if (size.width > maxWidth) {
    image = image.resize({ width: maxWidth, quality: "best" });
  }
  const encoded = image.toJPEG(quality);
  const key = `image-${String(Object.keys(imageData).length + 1).padStart(4, "0")}`;
  imageData[key] = `data:image/jpeg;base64,${encoded.toString("base64")}`;
  imageCache.set(cacheKey, key);
  encodedSourceBytes += source.length;
  encodedImageBytes += encoded.length;
  return key;
}

function imageTag(key, alt, className = "") {
  if (!key) return '<div class="missing-image">이미지를 찾지 못했습니다.</div>';
  return `<img class="${escapeHtml(className)}" data-image="${escapeHtml(
    key,
  )}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
}

function bboxText(bbox) {
  if (!bbox) return "—";
  if (Array.isArray(bbox))
    return bbox.map((value) => Math.round(value)).join(", ");
  return [bbox.x1, bbox.y1, bbox.x2, bbox.y2]
    .map((value) => Math.round(value))
    .join(", ");
}

function buildCandidateCard(page, candidate, kind, cropKey) {
  const isDialogue = kind === "dialogue";
  const estimate = candidate.estimate;
  const face = estimate?.facePx;
  const confidence = isDialogue
    ? candidate.hayaiConfidence
    : candidate.detectorConfidence;
  const searchable = [
    page.pageId,
    candidate.candidateId,
    kind,
    candidate.sourceText,
    bboxText(candidate.bbox),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ko-KR");
  return `
    <article class="crop-card ${isDialogue ? "dialogue" : "effect"}" data-search="${escapeHtml(
      searchable,
    )}">
      <div class="crop-image">${imageTag(
        cropKey,
        `${page.pageId} ${candidate.candidateId} 확대 crop`,
      )}</div>
      <div class="crop-copy">
        <div class="crop-heading">
          <strong>${escapeHtml(candidate.candidateId)}</strong>
          <span class="pill ${isDialogue ? "blue" : "purple"}">${
            isDialogue ? "일반 대사" : "효과음"
          }</span>
        </div>
        <dl>
          <div><dt>bbox</dt><dd>${escapeHtml(bboxText(candidate.bbox))}</dd></div>
          <div><dt>방향</dt><dd>${escapeHtml(candidate.direction ?? "—")}</dd></div>
          <div><dt>검출 신뢰도</dt><dd>${formatNumber(confidence)}</dd></div>
          <div><dt>source face</dt><dd>${
            Number.isFinite(face) ? `${formatNumber(face)}px` : "abstain"
          }</dd></div>
          <div><dt>추정 신뢰도</dt><dd>${formatNumber(estimate?.confidence)}</dd></div>
        </dl>
        ${
          candidate.sourceText
            ? `<details class="ocr-text"><summary>HayaiOCR 문자열</summary><p>${escapeHtml(
                candidate.sourceText,
              )}</p></details>`
            : ""
        }
      </div>
    </article>`;
}

function scoreDelta(before, after, lowerIsBetter = false) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0)
    return "—";
  const value = ((after - before) / before) * 100;
  const improved = lowerIsBetter ? value < 0 : value > 0;
  return `<span class="delta ${improved ? "up" : "down"}">${
    value > 0 ? "+" : ""
  }${formatNumber(value, 1)}%</span>`;
}

async function buildReport(outputPath) {
  const selection = readJson(path.join(campaignRoot, "selection.json"));
  const registry = readJson(
    path.join(repoRoot, "docs", "font-size-ai-lab-used-chapters.json"),
  );
  const finalReport = readJson(path.join(hayaiRoot, "baseline-report.json"));
  const geometry = readJson(
    path.join(geometryRoot, "geometry-evaluation.json"),
  );
  const evaluations = experimentSpecs.map((spec) => ({
    ...spec,
    evaluation: readJson(
      path.join(campaignRoot, spec.directory, "source-size-evaluation.json"),
    ),
  }));
  const baselineSummary = evaluations[0].evaluation.summary;
  const finalSummary = evaluations.at(-1).evaluation.summary;
  const registryEntry = registry.selections.find(
    (entry) => entry.normalizedKey === selection.normalizedKey,
  );

  const pageViews = [];
  for (const page of finalReport.pages) {
    const overlayKey = registerImage(path.join(hayaiRoot, page.overlayPath), {
      maxWidth: 980,
      quality: 86,
    });
    const dialogue = page.candidates.map((candidate) => ({
      candidate,
      cropKey: registerImage(path.join(hayaiRoot, candidate.cropPath), {
        maxWidth: 800,
        quality: 90,
      }),
    }));
    const effects = page.effectCandidates.map((candidate) => ({
      candidate,
      cropKey: registerImage(path.join(hayaiRoot, candidate.cropPath), {
        maxWidth: 800,
        quality: 90,
      }),
    }));
    pageViews.push({ page, overlayKey, dialogue, effects });
  }

  const changedViews = [];
  for (const page of geometry.pages) {
    const changedDirectory = path.join(
      geometryRoot,
      "pages",
      page.pageId,
      "changed",
    );
    for (const match of page.matches.filter((item) => item.changed)) {
      const stem = `${match.newRegionId}-from-${match.oldRegionId}`;
      changedViews.push({
        pageId: page.pageId,
        match,
        oldKey: registerImage(path.join(changedDirectory, `${stem}-old.png`), {
          maxWidth: 800,
          quality: 88,
        }),
        newKey: registerImage(path.join(changedDirectory, `${stem}-new.png`), {
          maxWidth: 800,
          quality: 88,
        }),
      });
    }
  }

  const severeViews = severeGeometryPages.map((item) => ({
    ...item,
    imageKey: registerImage(
      path.join(geometryRoot, "pages", item.pageId, "old-orange-new-green.png"),
      { maxWidth: 980, quality: 86 },
    ),
  }));
  const attachmentKey = registerImage(attachmentPath, {
    maxWidth: 600,
    quality: 92,
    required: false,
  });

  const experimentRows = evaluations
    .map(({ name, verdict, tone, finding, evaluation }) => {
      const summary = evaluation.summary;
      return `<tr>
        <td><strong>${escapeHtml(name)}</strong><br><span class="verdict ${tone}">${escapeHtml(
          verdict,
        )}</span></td>
        <td>${summary.dialogueCount}</td>
        <td>${summary.estimatedCount}</td>
        <td>${formatNumber(summary.coverage)}</td>
        <td>${formatNumber(summary.sameFontGroupScore)}</td>
        <td>${formatNumber(summary.smallTextRegressionPenalty)}</td>
        <td>${escapeHtml(finding)}</td>
      </tr>`;
    })
    .join("");

  const severeCards = severeViews
    .map(
      (item) => `<article class="evidence-card">
        <div class="evidence-title"><strong>${item.pageId}</strong><span>${escapeHtml(
          item.note,
        )}</span></div>
        ${imageTag(item.imageKey, `${item.pageId} 기존 주황 / 신규 초록 bbox 비교`)}
        <p>${
          Number.isFinite(item.old)
            ? `최대 페이지 면적 비율 <code>${formatNumber(item.old)}</code> → <code>${formatNumber(
                item.next,
              )}</code>`
            : escapeHtml(item.note)
        }</p>
      </article>`,
    )
    .join("");

  const pageSections = pageViews
    .map(({ page, overlayKey, dialogue, effects }) => {
      const cards = [
        ...dialogue.map(({ candidate, cropKey }) =>
          buildCandidateCard(page, candidate, "dialogue", cropKey),
        ),
        ...effects.map(({ candidate, cropKey }) =>
          buildCandidateCard(page, candidate, "effect", cropKey),
        ),
      ].join("");
      return `<details class="page-audit" id="audit-${page.pageId}">
        <summary>
          <span><strong>${page.pageId}</strong> · ${escapeHtml(page.name)}</span>
          <span class="page-counts">대사 ${page.dialogueCount} · 효과음 ${page.effectCount} · 추정 ${page.estimatedCount}</span>
        </summary>
        <div class="page-body">
          <figure class="page-overlay">
            ${imageTag(overlayKey, `${page.pageId} 최종 bbox 전체 오버레이`)}
            <figcaption>최종 전체 페이지 오버레이 · 일반 대사=청록, 효과음=보라</figcaption>
          </figure>
          <div class="crop-grid">${cards}</div>
        </div>
      </details>`;
    })
    .join("");

  const changedGroups = geometry.pages
    .filter((page) => page.changedCount > 0)
    .map((page) => {
      const pairs = changedViews
        .filter((view) => view.pageId === page.pageId)
        .map(
          ({
            match,
            oldKey,
            newKey,
          }) => `<article class="pair-card crop-card" data-search="${escapeHtml(
            `${page.pageId} ${match.newRegionId} ${match.oldRegionId}`.toLowerCase(),
          )}">
            <header><strong>${page.pageId} ${escapeHtml(
              match.newRegionId,
            )}</strong><span>기존 ${escapeHtml(match.oldRegionId)} · IoU ${formatNumber(
              match.bboxIou,
            )}</span></header>
            <div class="pair-images">
              <figure>${imageTag(oldKey, `${page.pageId} ${match.oldRegionId} 기존 bbox crop`)}<figcaption>기존 · ${escapeHtml(
                bboxText(match.oldBbox),
              )}</figcaption></figure>
              <figure>${imageTag(newKey, `${page.pageId} ${match.newRegionId} 신규 bbox crop`)}<figcaption>신규 · ${escapeHtml(
                bboxText(match.newBbox),
              )}</figcaption></figure>
            </div>
          </article>`,
        )
        .join("");
      return `<details class="changed-page">
        <summary><strong>${page.pageId}</strong> · 변경 ${page.changedCount}개 · 대사 ${page.oldDialogueCount}→${page.newDialogueCount}</summary>
        <div class="pair-grid">${pairs}</div>
      </details>`;
    })
    .join("");

  const generatedAt = new Date().toISOString();
  const sourceImageCount = Object.keys(imageData).length;
  const imageJson = JSON.stringify(imageData).replaceAll("<", "\\u003c");
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글자 크기 AI · 캠페인 001 화별 리포트</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d12; --panel:#141822; --panel2:#1a202c; --line:#2b3445; --text:#edf2f7; --muted:#9eabc0; --accent:#55d6be; --blue:#78a9ff; --purple:#c594ff; --good:#54d187; --warn:#f7c75c; --bad:#ff7d7d; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:radial-gradient(circle at 15% 0%, #172035 0, var(--bg) 35rem); color:var(--text); font:15px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif; }
    a { color:#9ac3ff; } code { color:#b8f4e9; background:#0b1019; padding:.12rem .35rem; border-radius:.35rem; }
    img { display:block; max-width:100%; height:auto; background:#fff; border-radius:.55rem; }
    .shell { width:min(1560px,100%); margin:0 auto; padding:0 22px 72px; }
    .hero { padding:58px 0 28px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:28px; align-items:end; }
    .eyebrow { margin:0 0 8px; color:var(--accent); font-weight:750; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin:0; max-width:920px; font-size:clamp(2rem,5vw,4.6rem); line-height:1.03; letter-spacing:-.055em; }
    .lead { max-width:900px; color:#c6d0df; font-size:1.08rem; }
    .version { background:linear-gradient(145deg,#1c3b38,#142424); border:1px solid #327267; border-radius:1rem; padding:16px 20px; min-width:230px; }
    .version strong { display:block; font-size:1.5rem; color:#8af2de; } .version span { color:#b7d7d0; }
    .sticky { position:sticky; z-index:20; top:0; margin:0 -22px 26px; padding:10px 22px; display:flex; gap:8px; overflow:auto; background:rgba(11,13,18,.9); backdrop-filter:blur(16px); border-block:1px solid rgba(255,255,255,.08); }
    .sticky a { white-space:nowrap; text-decoration:none; color:#d8e0ec; background:#1a202c; border:1px solid #30394a; border-radius:999px; padding:7px 12px; }
    section { margin:36px 0; scroll-margin-top:76px; } h2 { margin:0 0 16px; font-size:clamp(1.45rem,3vw,2.25rem); letter-spacing:-.025em; } h3 { margin:20px 0 8px; }
    .grid { display:grid; gap:14px; } .summary-grid { grid-template-columns:repeat(4,minmax(0,1fr)); }
    .metric { border:1px solid var(--line); border-radius:.9rem; padding:18px; background:rgba(20,24,34,.82); }
    .metric small { display:block; color:var(--muted); } .metric strong { display:block; margin:3px 0; font-size:1.65rem; }
    .delta { font-size:.82rem; font-weight:700; } .delta.up { color:var(--good); } .delta.down { color:var(--bad); }
    .callout { border-left:4px solid var(--accent); background:#111a20; padding:16px 18px; border-radius:.5rem; }
    .warning { border-left-color:var(--warn); background:#211c10; } .bad-callout { border-left-color:var(--bad); background:#221416; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:.8rem; }
    table { width:100%; min-width:1080px; border-collapse:collapse; background:rgba(20,24,34,.9); }
    th,td { text-align:left; vertical-align:top; padding:12px 13px; border-bottom:1px solid var(--line); } th { position:sticky; top:0; background:#202634; color:#c9d3e2; }
    .verdict,.pill { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:.76rem; font-weight:750; }
    .verdict.good { color:#baf7d1; background:#153a25; } .verdict.warn { color:#ffe9a8; background:#473a16; } .verdict.bad { color:#ffc1c1; background:#4c1e24; } .verdict.neutral { color:#d3dbea; background:#2b3241; }
    .fixed-grid { grid-template-columns:minmax(260px,420px) minmax(0,1fr); align-items:start; }
    .fixed-grid figure { margin:0; padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:.8rem; }
    .fixed-grid figcaption, figcaption { color:var(--muted); margin-top:8px; font-size:.86rem; }
    .evidence-grid { grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
    .evidence-card { background:var(--panel); border:1px solid var(--line); border-radius:.8rem; padding:12px; }
    .evidence-title { display:flex; justify-content:space-between; gap:10px; margin-bottom:10px; } .evidence-title span { color:var(--muted); font-size:.87rem; text-align:right; }
    .research-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .research-card { background:linear-gradient(145deg,#17202c,#111722); border:1px solid #2f3b50; border-radius:.9rem; padding:18px; }
    .research-card .tag { color:var(--accent); font-size:.82rem; font-weight:800; }
    .toolbar { display:flex; flex-wrap:wrap; gap:9px; align-items:center; margin:12px 0; }
    .toolbar input { flex:1 1 330px; color:var(--text); background:#0c1119; border:1px solid #354158; border-radius:.55rem; padding:10px 12px; font:inherit; }
    button { color:var(--text); background:#222a39; border:1px solid #3c4860; border-radius:.55rem; padding:9px 12px; cursor:pointer; } button:hover { background:#2c3649; }
    details { border:1px solid var(--line); border-radius:.8rem; background:rgba(20,24,34,.83); overflow:clip; } details + details { margin-top:9px; } summary { cursor:pointer; padding:13px 15px; }
    .page-audit > summary,.changed-page > summary { display:flex; justify-content:space-between; gap:12px; font-size:1rem; background:#171c27; }
    .page-counts { color:var(--muted); font-size:.87rem; } .page-body { padding:14px; }
    .page-overlay { width:min(100%,920px); margin:0 auto 18px; }
    .crop-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:12px; align-items:start; }
    .crop-card { border:1px solid #303a4d; border-radius:.75rem; background:#10151e; overflow:hidden; } .crop-card.effect { border-color:#4f3b66; }
    .crop-image { display:grid; place-items:center; min-height:100px; padding:8px; background:#e8e8e8; } .crop-image img { max-height:520px; object-fit:contain; }
    .crop-copy { padding:11px; } .crop-heading { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .pill.blue { color:#cfe0ff; background:#1d3f70; } .pill.purple { color:#ead7ff; background:#4a2b67; }
    dl { margin:8px 0 0; } dl div { display:grid; grid-template-columns:110px 1fr; gap:8px; border-top:1px solid #252d3c; padding:4px 0; } dt { color:var(--muted); } dd { margin:0; }
    .ocr-text { margin-top:8px; border:0; background:transparent; } .ocr-text summary { padding:5px 0; color:#b9c8de; } .ocr-text p { max-height:12rem; overflow:auto; word-break:break-all; margin:5px 0; color:#d2d9e5; font-size:.87rem; }
    .changed-page { background:#151922; } .pair-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(410px,1fr)); gap:12px; padding:12px; }
    .pair-card header { display:flex; justify-content:space-between; gap:8px; padding:10px 12px; } .pair-card header span { color:var(--muted); font-size:.82rem; }
    .pair-images { display:grid; grid-template-columns:1fr 1fr; gap:2px; background:#2d3545; } .pair-images figure { margin:0; padding:7px; background:#e9e9e9; color:#222; }
    .pair-images img { width:100%; height:310px; object-fit:contain; } .pair-images figcaption { color:#444; word-break:break-all; }
    .audit-ledger { columns:2 320px; } .audit-ledger li { break-inside:avoid; margin-bottom:8px; }
    .missing-image { padding:30px; color:#ffd3d3; background:#431d25; } .image-error { outline:4px solid var(--bad); } .no-results { display:none; padding:14px; color:var(--warn); }
    footer { margin-top:54px; color:var(--muted); border-top:1px solid var(--line); padding-top:18px; }
    @media (max-width:900px) { .hero { grid-template-columns:1fr; } .summary-grid,.research-grid { grid-template-columns:1fr 1fr; } .fixed-grid { grid-template-columns:1fr; } }
    @media (max-width:600px) { .shell { padding-inline:12px; } .sticky { margin-inline:-12px; padding-inline:12px; } .summary-grid,.research-grid { grid-template-columns:1fr; } .page-audit > summary,.changed-page > summary { display:block; } .page-counts { display:block; margin-top:3px; } .pair-grid { grid-template-columns:1fr; padding:7px; } .pair-images { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Font-size AI · chapter campaign 001</p>
        <h1>글자 크기와 HayaiOCR bbox를 한 화 끝까지 뜯어본 기록</h1>
        <p class="lead"><strong>${escapeHtml(selection.series)} · ${escapeHtml(
          selection.chapter,
        )}</strong><br>무작위 봉인된 32페이지에서 정확히 5개 가설을 실험했고, 각 bbox 확대 감사와 실제 CUDA HayaiOCR 재실행까지 마쳤다.</p>
      </div>
      <div class="version"><span>현재 내부 실험 버전</span><strong>fsai-lab-v0.1.0</strong><span>캠페인 001 승격 · 다음 미사용 화 유지 검증 대기</span></div>
    </header>

    <nav class="sticky" aria-label="리포트 목차">
      <a href="#outcome">결론</a><a href="#experiments">5개 실험</a><a href="#fixed-case">사용자 사례</a><a href="#geometry">bbox 개선</a><a href="#research">200회 조사</a><a href="#all-bboxes">전체 ${finalReport.summary.dialogueCount + finalReport.summary.effectCount}개 bbox</a><a href="#changed">변경 81개 전후</a><a href="#ledger">검증 장부</a>
    </nav>

    <main>
      <section id="outcome">
        <h2>결론부터</h2>
        <div class="summary-grid grid">
          <div class="metric"><small>source-face 적용률</small><strong>${formatNumber(
            finalSummary.coverage * 100,
            2,
          )}%</strong>${scoreDelta(baselineSummary.coverage, finalSummary.coverage)}</div>
          <div class="metric"><small>같은 글꼴 불일치 · 낮을수록 좋음</small><strong>${formatNumber(
            finalSummary.sameFontGroupScore,
          )}</strong>${scoreDelta(
            baselineSummary.sameFontGroupScore,
            finalSummary.sameFontGroupScore,
            true,
          )}</div>
          <div class="metric"><small>최종 대사 bbox</small><strong>${finalReport.summary.dialogueCount}</strong><span class="delta up">기준선 ${baselineSummary.dialogueCount} → +${
            finalReport.summary.dialogueCount - baselineSummary.dialogueCount
          }</span></div>
          <div class="metric"><small>작은 글자 퇴행</small><strong>${formatNumber(
            finalSummary.smallTextRegressionPenalty,
          )}</strong><span class="delta up">P022/P029 sentinel 보존</span></div>
        </div>
        <p class="callout"><strong>승격 판단:</strong> 85% dominant-column core와 robust tail + bubble/panel ownership + 강한 pixel-overlap 중복 억제를 제품 경로에 반영했다. 기준선보다 적용률은 10.03%p 높고 같은 글꼴 불일치는 약 70% 낮아졌다. 단, 이 화를 다시 계수 조정에 쓰지 않고 다음 미사용 화에서 유지돼야 조건부 꼬리표가 떨어진다.</p>
        <p class="callout warning"><strong>남은 위험:</strong> 광고 띠·작가명·페이지 번호가 일반 대사 후보로 남는 사례와 대사/효과음 중복 분류가 있다. 합침 오류보다 안전한 방향이지만 semantic filtering은 아직 해결 범위 밖이다.</p>
      </section>

      <section id="experiments">
        <h2>한 화에서 사용한 정확히 5개 실험</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>가설·판정</th><th>대사</th><th>추정</th><th>적용률</th><th>같은 글꼴 점수↓</th><th>작은 글자 퇴행</th><th>무엇을 배웠나</th></tr></thead>
          <tbody>${experimentRows}</tbody>
        </table></div>
        <p class="callout bad-callout"><strong>반복 금지:</strong> 고정 95% 질량을 본문 core로 취급, confidence만으로 bbox 삭제/trim, bbox 포함관계만으로 nested 후보 제거, 작은 component 전부 삭제, 전역 14/16px 최소값, page-wide median 복사.</p>
      </section>

      <section id="fixed-case">
        <h2>사용자 첨부 사례: 왜 아래 글씨만 작아졌나</h2>
        <div class="fixed-grid grid">
          <figure>${imageTag(attachmentKey, "사용자가 첨부한 글자 크기 불일치 사례")}<figcaption>고정 진단 이미지 · 랜덤 실험/승격률 계산에는 사용하지 않음</figcaption></figure>
          <div>
            <p><strong>번역:</strong> 위 “어라?”, 아래 “우리 지하에 잠입했던 거 맞죠?”</p>
            <p>원문 두 블록은 육안상 거의 같은 본문 크기다. 위는 <code>21.5624px</code>로 측정됐지만 아래 3열은 Hayai/Koharu가 105×189px 한 영역으로 묶었고 기존 zero-gap 분할이 <code>20/53/4px</code>로 붕괴해 abstain했다. 결국 아래만 12px fallback을 받아 첨부처럼 작아졌다.</p>
            <p>실험 2의 density valley가 아래를 <code>22.009px</code>로 복구했고, 실험 4의 dominant core가 ruby/satellite 반례까지 막아 제품 후보가 됐다.</p>
            <p class="callout">핵심은 전역 최소 글자 크기가 아니라 <strong>하나로 합쳐진 다열 영역 안에서 본문 열 geometry를 되찾는 것</strong>이다.</p>
          </div>
        </div>
      </section>

      <section id="geometry">
        <h2>심각한 bbox 7개군 전후 비교</h2>
        <p>주황은 기존, 초록은 신규 bbox다. confidence만으로 지우지 않고 text-mask 0.5% tail, 면적 개선 1.25배, container support, owner 분리, 실제 mask overlap을 결합했다.</p>
        <div class="evidence-grid grid">${severeCards}</div>
      </section>

      <section id="research">
        <h2>5번째 실험 직후 수행한 200회 상세 조사</h2>
        <p>서로 다른 질의 200개(최초 4 + 28주제×7관점), 49개 결과 batch, URL 언급 1,231건, 중복 제거 930개를 조사했다. 설계 판단은 논문·저자 공식 구현·공식 데이터셋을 우선했다.</p>
        <div class="research-grid grid">
          <article class="research-card"><span class="tag">R1 · 다음 화 도입</span><h3>projection + component affinity</h3><p>85% projection core와 connected-component graph가 각각 글자 크기를 추정한다. 본문 최대 일관 군집과 ruby secondary scale을 분리하고 두 추정이 합의할 때만 신뢰도를 높인다.</p><p><a href="https://arxiv.org/abs/2207.03960">Furigana detection</a> · <a href="https://arxiv.org/abs/1801.01315">PixelLink</a> · <a href="https://arxiv.org/abs/1908.05900">PAN</a></p></article>
          <article class="research-card"><span class="tag">R2 · 다음 화 도입</span><h3>양·음 링크 bbox graph</h3><p>같은 owner·높은 mask overlap은 양의 link, 다른 owner·repulsive valley는 음의 link로 둔다. 작은 core에서 완전 mask로 확장해 transitive 패널 횡단 union을 막는다.</p><p><a href="https://arxiv.org/abs/1806.02559">PSENet</a> · <a href="https://openaccess.thecvf.com/content_CVPRW_2020/papers/w34/Liu_An_Accurate_Segmentation-Based_Scene_Text_Detector_With_Context_Attention_and_CVPRW_2020_paper.pdf">Repulsive Text Border</a></p></article>
          <article class="research-card"><span class="tag">R3 · 평가 분리</span><h3>한 숫자로 숨기지 않기</h3><p>누락, 과병합, 과분할, 대사/효과음 중복, 잘림, ruby 혼합, 크기 불일치, 실제 작은 글자 퇴행을 별도 집계한다.</p><p><a href="https://arxiv.org/abs/2605.21182">Manga109-v2026</a> · <a href="https://arxiv.org/abs/2010.03997">Unconstrained Manga Text</a></p></article>
        </div>
      </section>

      <section id="all-bboxes">
        <h2>최종 32페이지 · bbox ${finalReport.summary.dialogueCount + finalReport.summary.effectCount}개 전수 확대</h2>
        <p>각 페이지의 전체 오버레이와 일반 대사 ${finalReport.summary.dialogueCount}개, 효과음 ${finalReport.summary.effectCount}개 crop을 모두 포함했다. 검색하면 페이지 ID, 후보 ID, bbox, OCR 문자열로 카드가 걸러진다.</p>
        <div class="toolbar"><input id="bbox-search" type="search" placeholder="예: P031, D004, FX002, OCR 문자열"><button type="button" data-open=".page-audit">페이지 모두 열기</button><button type="button" data-close=".page-audit">모두 닫기</button></div>
        <div id="bbox-pages">${pageSections}</div>
        <p id="no-results" class="no-results">검색 조건과 맞는 bbox가 없습니다.</p>
      </section>

      <section id="changed">
        <h2>변경 bbox 81개 · 기존/신규 확대쌍</h2>
        <p>초기 후보의 82개 변경 crop을 전수 검사해 P014 판매문구 nested duplicate를 잡았고, 강한 실제 mask-overlap 조건을 추가한 뒤 최종 81개를 다시 확인했다. 아래는 최종 r2의 모든 변경쌍이다.</p>
        <div class="toolbar"><button type="button" data-open=".changed-page">변경 페이지 모두 열기</button><button type="button" data-close=".changed-page">모두 닫기</button></div>
        ${changedGroups}
      </section>

      <section id="ledger">
        <h2>검증 장부와 재현 경계</h2>
        <ul class="audit-ledger">
          <li>무작위 봉인 seed: <code>${escapeHtml(selection.seed)}</code></li>
          <li>사용 화 레지스트리 상태: <code>${escapeHtml(
            registryEntry?.status ?? "missing",
          )}</code></li>
          <li>원본 ${selection.pageCount}페이지 SHA-256과 byte size를 selection.json에 봉인.</li>
          <li>실제 HayaiOCR <code>full</code>, GPU CUDA/cu126, 32/32페이지 완주.</li>
          <li>일반 대사 ${finalReport.summary.dialogueCount}, 효과음 ${finalReport.summary.effectCount}, source-face ${finalReport.summary.estimatedCount}, abstain ${
            finalReport.summary.dialogueCount -
            finalReport.summary.estimatedCount
          }, 빈 OCR 0.</li>
          <li>replay와 실제 runtime manifest 32/32 구조 일치.</li>
          <li>최종 변경 81개 + 기존 정상 177개 연결로 일반 대사 258개 전부 확대 감사.</li>
          <li>효과음 115개도 이 보고서에 전부 포함.</li>
          <li>focused Vitest 4파일 29개 통과, Electron compile 통과.</li>
          <li>전체 <code>npm run check</code>를 통과했다(2026-09-02, 283.35초).</li>
          <li>원본 Tachidesk 화와 앱 library/output은 읽기만 했고 수정하지 않았다.</li>
          <li>이 화는 성공·실패와 무관하게 영구 재사용 금지.</li>
        </ul>
        <p class="callout"><strong>다음 화:</strong> 이전에 쓰지 않은 화를 새 seed로 봉인하고, R1 component-affinity와 R2 positive/negative instance graph를 첫 조합으로 실험한다. 캠페인 001 수치로 계수를 다시 맞추지 않는다.</p>
      </section>
    </main>

    <footer>
      생성 시각 ${escapeHtml(generatedAt)} · 내장 이미지 ${sourceImageCount}개 · 원본 증거 ${formatNumber(
        encodedSourceBytes / 1024 / 1024,
        1,
      )}MiB → HTML용 JPEG ${formatNumber(encodedImageBytes / 1024 / 1024, 1)}MiB · 소스 경로 ${escapeHtml(
        relativeToRepo(campaignRoot),
      )}
    </footer>
  </div>

  <script id="image-data" type="application/json">${imageJson}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById("image-data").textContent);
      const hydrate = (image) => {
        const key = image.dataset.image;
        if (!key || image.src) return;
        image.addEventListener("error", () => image.classList.add("image-error"), { once: true });
        image.src = data[key];
      };
      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            hydrate(entry.target);
            observer.unobserve(entry.target);
          }
        }, { rootMargin: "900px 0px" });
        document.querySelectorAll("img[data-image]").forEach((image) => observer.observe(image));
      } else {
        document.querySelectorAll("img[data-image]").forEach(hydrate);
      }
      document.querySelectorAll("button[data-open]").forEach((button) => {
        button.addEventListener("click", () => document.querySelectorAll(button.dataset.open).forEach((item) => { item.open = true; }));
      });
      document.querySelectorAll("button[data-close]").forEach((button) => {
        button.addEventListener("click", () => document.querySelectorAll(button.dataset.close).forEach((item) => { item.open = false; }));
      });
      const search = document.getElementById("bbox-search");
      const noResults = document.getElementById("no-results");
      search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase("ko-KR");
        let visibleCount = 0;
        document.querySelectorAll(".page-audit").forEach((page) => {
          let pageCount = 0;
          page.querySelectorAll(".crop-card").forEach((card) => {
            const visible = !query || card.dataset.search.includes(query);
            card.style.display = visible ? "" : "none";
            if (visible) pageCount += 1;
          });
          page.style.display = pageCount > 0 ? "" : "none";
          if (query && pageCount > 0) page.open = true;
          visibleCount += pageCount;
        });
        noResults.style.display = visibleCount > 0 ? "none" : "block";
      });
    })();
  </script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  const bytes = fs.statSync(outputPath).size;
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(outputPath))
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    output: relativeToRepo(outputPath),
    byteSize: bytes,
    sha256,
    embeddedImageCount: sourceImageCount,
    encodedSourceBytes,
    encodedImageBytes,
    dialogueCount: finalReport.summary.dialogueCount,
    effectCount: finalReport.summary.effectCount,
    changedBboxCount: geometry.totals.changedCount,
    internalVersion: "fsai-lab-v0.1.0",
  };
  const manifestPath = path.join(
    path.dirname(outputPath),
    "chapter-report.manifest.json",
  );
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      { ...manifest, manifest: relativeToRepo(manifestPath) },
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
    console.error(error);
    app.exit(1);
  });

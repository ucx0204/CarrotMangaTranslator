#!/usr/bin/env electron
/* eslint-disable -- isolated self-contained visual audit report generator */
// @ts-nocheck -- experiment utility; production types remain checked.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const repoRoot = path.resolve(__dirname, "../..");
const defaultSuite = path.join(
  repoRoot,
  "artifacts",
  "font-size-ai-lab",
  "failure-balloon-regression-001",
  "suite-manifest.json",
);

function parseArgs(argv) {
  const args = {
    baseline: null,
    experiment: null,
    output: null,
    suite: defaultSuite,
    version: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (value === "--experiment") args.experiment = Number(argv[++index]);
    else if (value === "--output") args.output = path.resolve(argv[++index]);
    else if (value === "--suite") args.suite = path.resolve(argv[++index]);
    else if (value === "--version") args.version = String(argv[++index]);
    else if (value === "--help") {
      console.log(
        "Usage: electron scripts/font-size-ai-lab/build-failure-balloon-checkpoint-report.cjs " +
          "--baseline PATH --experiment N --version LABEL --output PATH [--suite PATH]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  for (const key of ["baseline", "output", "suite", "version"]) {
    if (!args[key]) throw new Error(`--${key} is required.`);
  }
  if (!Number.isInteger(args.experiment) || args.experiment < 1) {
    throw new Error("--experiment must be a positive integer.");
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
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

function bboxText(bbox) {
  if (!bbox) return "—";
  return [bbox.x1, bbox.y1, bbox.x2, bbox.y2]
    .map((value) => Math.round(Number(value)))
    .join(", ");
}

function samePath(left, right) {
  return (
    path.resolve(left).localeCompare(path.resolve(right), undefined, {
      sensitivity: "accent",
    }) === 0
  );
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

const imageData = Object.create(null);
let embeddedJpegBytes = 0;
const imageCounts = { bbox: 0, page: 0 };

function registerImage(filePath, { maxWidth, prefix, quality }) {
  const source = fs.readFileSync(filePath);
  let image = nativeImage.createFromBuffer(source);
  if (image.isEmpty()) throw new Error(`Electron could not decode ${filePath}`);
  const size = image.getSize();
  if (size.width > maxWidth) {
    image = image.resize({ width: maxWidth, quality: "best" });
  }
  const encoded = image.toJPEG(quality);
  imageCounts[prefix] += 1;
  const key = `${prefix}-${String(imageCounts[prefix]).padStart(4, "0")}`;
  imageData[key] = `data:image/jpeg;base64,${encoded.toString("base64")}`;
  embeddedJpegBytes += encoded.length;
  return key;
}

function registerPageImage(filePath) {
  return registerImage(filePath, {
    maxWidth: 1_200,
    prefix: "page",
    quality: 86,
  });
}

function registerCandidateImage(filePath) {
  return registerImage(filePath, {
    maxWidth: 900,
    prefix: "bbox",
    quality: 90,
  });
}

function candidateRows(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return '<p class="empty">일반 대사 bbox 없음</p>';
  }
  return `<div class="candidate-list">${candidates
    .map(
      ({ candidate, imageKey }) => `<article class="candidate">
        <button class="candidate-image" type="button" data-zoom="${escapeHtml(imageKey)}" aria-label="${escapeHtml(
          `${candidate.candidateId} bbox 확대`,
        )}">
          <img data-image="${escapeHtml(imageKey)}" alt="${escapeHtml(
            `${candidate.candidateId} 일반 대사 bbox 확대본`,
          )}" loading="lazy" decoding="async">
        </button>
        <div class="candidate-meta">
        <strong>${escapeHtml(candidate.candidateId)}</strong>
        <code>${escapeHtml(bboxText(candidate.bbox))}</code>
        <span>${escapeHtml(candidate.direction ?? "—")}</span>
        <span>Hayai ${formatNumber(candidate.hayaiConfidence)}</span>
        <span>${candidate.estimate ? `${formatNumber(candidate.estimate.facePx)}px` : "size abstain"}</span>
        ${candidate.sourceText ? `<p lang="ja">${escapeHtml(candidate.sourceText)}</p>` : ""}
        </div>
      </article>`,
    )
    .join("")}</div>`;
}

function pageNote(page) {
  const directGold = page.reasons.filter((reason) =>
    reason.startsWith("USER GOLD 2026-09-03"),
  );
  if (directGold.length > 0) {
    const neutral = page.tags.includes("user-neutral");
    return `<div class="gold ${neutral ? "neutral" : "fail"}"><strong>${
      neutral ? "사용자 중립 기준" : "사용자 직접 판정"
    }</strong><span>${directGold.map(escapeHtml).join("<br>")}</span></div>`;
  }
  if (page.suitePageId === "P055") {
    return `<div class="gold fail"><strong>사용자 실패 기준</strong><span>서로 닿은 두 말풍선이다. 위 T006의 빌려온 꼬리만 잘라내고 아래 T020을 별도 영역으로 보존해야 한다. v0.8의 결합은 오답이다.</span></div>`;
  }
  if (page.suitePageId === "P070") {
    return `<div class="gold pass"><strong>사용자 승인 정답</strong><span>페이지를 가로지르는 긴 오검출 꼬리만 제거하고 실제 대사 블록과 발화 수를 보존한 형태를 유지해야 한다.</span></div>`;
  }
  if (page.suitePageId === "P080") {
    return `<div class="gold fail"><strong>사용자 분리 기준</strong><span>이어진 두 말풍선을 하나로 결합하면 안 된다. 각 말풍선의 텍스트 영역을 독립적으로 유지해야 한다.</span></div>`;
  }
  return "";
}

async function buildReport(args) {
  const suite = readJson(args.suite);
  const baseline = readJson(args.baseline);
  const baselineRoot = path.dirname(args.baseline);
  if (baseline.overlayMode !== "ordinary-only") {
    throw new Error(
      `Checkpoint report requires ordinary-only overlays; got ${baseline.overlayMode ?? "legacy/unknown"}.`,
    );
  }
  if (baseline.ocr?.pipeline !== "hayai") {
    throw new Error(
      `Baseline OCR pipeline is not HayaiOCR: ${baseline.ocr?.pipeline}`,
    );
  }
  if (suite.pageCount !== suite.pages.length) {
    throw new Error("Suite pageCount does not match pages[].");
  }
  if (baseline.pages.length !== suite.pages.length) {
    throw new Error(
      `Baseline/suite page mismatch: ${baseline.pages.length}/${suite.pages.length}`,
    );
  }

  const views = [];
  let sourceHashVerifiedCount = 0;
  for (let index = 0; index < suite.pages.length; index += 1) {
    const suitePage = suite.pages[index];
    const page = baseline.pages[index];
    if (page.pageId !== suitePage.suitePageId) {
      throw new Error(
        `Page id mismatch at ${index}: ${page.pageId}/${suitePage.suitePageId}`,
      );
    }
    if (!samePath(page.imagePath, suitePage.path)) {
      throw new Error(`Source path mismatch for ${suitePage.suitePageId}.`);
    }
    const actualSha = sha256File(suitePage.path);
    if (actualSha !== suitePage.sha256 || page.sha256 !== suitePage.sha256) {
      throw new Error(`Source SHA mismatch for ${suitePage.suitePageId}.`);
    }
    sourceHashVerifiedCount += 1;
    const overlayPath = path.resolve(baselineRoot, page.overlayPath);
    if (!fs.existsSync(overlayPath)) {
      throw new Error(`Missing full-page overlay: ${overlayPath}`);
    }
    const candidates = page.candidates.map((candidate) => {
      const cropPath = path.resolve(baselineRoot, candidate.cropPath);
      if (!fs.existsSync(cropPath)) {
        throw new Error(`Missing enlarged bbox crop: ${cropPath}`);
      }
      return { candidate, imageKey: registerCandidateImage(cropPath) };
    });
    views.push({
      candidates,
      imageKey: registerPageImage(overlayPath),
      page,
      suitePage,
    });
  }

  const campaignOptions = [
    ...new Set(suite.pages.map((page) => page.sourceCampaign)),
  ]
    .sort()
    .map(
      (campaign) =>
        `<option value="${escapeHtml(campaign)}">${escapeHtml(campaign)}</option>`,
    )
    .join("");
  const pageCards = views
    .map(({ candidates, imageKey, page, suitePage }) => {
      const searchable = [
        suitePage.suitePageId,
        suitePage.sourceCampaign,
        suitePage.sourcePageId,
        suitePage.sourceName,
        ...suitePage.tags,
        ...suitePage.reasons,
      ]
        .join(" ")
        .toLocaleLowerCase("ko-KR");
      return `<article class="page-card" id="${escapeHtml(suitePage.suitePageId)}" data-campaign="${escapeHtml(
        suitePage.sourceCampaign,
      )}" data-search="${escapeHtml(searchable)}">
        <header>
          <div><strong>${escapeHtml(suitePage.suitePageId)}</strong><span>${escapeHtml(
            suitePage.sourceCampaign,
          )} / ${escapeHtml(suitePage.sourcePageId)} · ${escapeHtml(suitePage.sourceName)}</span></div>
          <div class="counts">일반 대사 ${page.dialogueCount} · 크기 추정 ${page.estimatedCount}</div>
        </header>
        ${pageNote(suitePage)}
        <button class="page-image" type="button" data-zoom="${escapeHtml(imageKey)}" aria-label="${escapeHtml(
          suitePage.suitePageId,
        )} 전체 페이지 확대">
          <img data-image="${escapeHtml(imageKey)}" alt="${escapeHtml(
            `${suitePage.suitePageId} 일반 대사 bbox 전체 페이지`,
          )}" loading="lazy" decoding="async">
        </button>
        <div class="tags">${suitePage.tags
          .map((tag) => `<span>${escapeHtml(tag)}</span>`)
          .join("")}</div>
        <details><summary>선정 근거 · bbox 값 · HayaiOCR 문자열 · 확대본 ${candidates.length}개</summary>
          <ul>${suitePage.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
          ${candidateRows(candidates)}
        </details>
      </article>`;
    })
    .join("");

  const generatedAt = new Date().toISOString();
  const imageJson = JSON.stringify(imageData).replaceAll("<", "\\u003c");
  const title = `말풍선 실패 회귀 · 실험 ${args.experiment}`;
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme:light; --ink:#172033; --muted:#62708a; --line:#dce3ed; --panel:#f7f9fc; --red:#d92f3c; --green:#12845b; --amber:#a56600; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:#eef2f7; color:var(--ink); font:15px/1.58 system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif; }
    .shell { width:min(1900px,100%); margin:auto; padding:30px 24px 80px; }
    .hero { display:grid; grid-template-columns:1fr auto; gap:24px; align-items:end; }
    h1 { margin:0; font-size:clamp(2rem,4vw,4rem); line-height:1.05; letter-spacing:-.045em; }
    .lead { max-width:1050px; color:#47546b; font-size:1.05rem; }
    .version { min-width:260px; padding:16px 19px; background:#172033; color:white; border-radius:16px; }
    .version small,.version span { display:block; color:#cbd6e8; } .version strong { display:block; font-size:1.5rem; color:#8be2c2; }
    .warning { margin:24px 0; padding:15px 18px; border-left:5px solid var(--amber); background:#fff4d9; border-radius:10px; }
    .anchors { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:18px 0; }
    .anchor { padding:14px; color:inherit; text-decoration:none; background:white; border:1px solid var(--line); border-radius:12px; }
    .anchor strong { display:block; } .anchor span { color:var(--muted); }
    .toolbar { position:sticky; top:0; z-index:10; display:flex; gap:9px; flex-wrap:wrap; padding:12px; margin:20px 0; background:rgba(238,242,247,.94); backdrop-filter:blur(12px); border-block:1px solid var(--line); }
    input,select { min-width:230px; flex:1; padding:10px 12px; border:1px solid #bfc9d8; border-radius:9px; background:white; font:inherit; }
    .summary { color:var(--muted); padding:10px 0; }
    .page-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(620px,100%),1fr)); gap:18px; align-items:start; }
    .page-card { background:white; border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 7px 25px rgba(37,48,70,.08); }
    .page-card > header { display:flex; justify-content:space-between; gap:12px; padding:14px 16px; border-bottom:1px solid var(--line); }
    .page-card header strong { display:block; font-size:1.15rem; } .page-card header span,.counts { color:var(--muted); }
    .counts { white-space:nowrap; }
    .page-image { display:block; width:100%; padding:12px; border:0; background:#e6eaf0; cursor:zoom-in; }
    .page-image img { display:block; width:100%; height:auto; margin:auto; background:white; }
    .gold { display:flex; gap:10px; padding:10px 15px; border-bottom:1px solid var(--line); }
    .gold strong { white-space:nowrap; } .gold.fail { background:#fff0f0; color:#7e1c25; } .gold.pass { background:#eaf8f2; color:#0d6243; } .gold.neutral { background:#eef3fb; color:#41526f; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; padding:12px 15px 4px; }
    .tags span { padding:3px 8px; border-radius:999px; background:#edf2f8; color:#4c5a72; font-size:.78rem; }
    details { margin:8px 15px 15px; border:1px solid var(--line); border-radius:10px; } summary { cursor:pointer; padding:10px 12px; font-weight:650; }
    details ul { margin:0 16px 12px 32px; padding:0; color:#46536a; }
    .candidate-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr)); gap:10px; padding:0 10px 10px; }
    .candidate { overflow:hidden; border:1px solid var(--line); border-radius:9px; background:var(--panel); }
    .candidate-image { display:block; width:100%; min-height:120px; padding:8px; border:0; border-bottom:1px solid var(--line); background:#dfe5ed; cursor:zoom-in; }
    .candidate-image img { display:block; width:100%; height:auto; max-height:650px; margin:auto; object-fit:contain; background:white; }
    .candidate-meta { padding:9px; } .candidate strong,.candidate code,.candidate span { margin-right:8px; } .candidate p { margin:6px 0 0; word-break:break-all; }
    code { background:#e8edf4; padding:2px 5px; border-radius:5px; } .empty { padding:0 12px 12px; color:var(--muted); }
    .modal { position:fixed; inset:0; z-index:50; display:none; padding:18px; background:rgba(7,10,16,.94); overflow:auto; cursor:zoom-out; }
    .modal.open { display:grid; place-items:start center; } .modal img { display:block; max-width:none; width:auto; min-width:min(1200px,100%); height:auto; background:white; }
    footer { margin-top:36px; padding-top:16px; border-top:1px solid #cbd4e1; color:var(--muted); }
    @media(max-width:850px){ .shell{padding:20px 10px 60px}.hero{grid-template-columns:1fr}.anchors{grid-template-columns:1fr}.page-card>header{display:block}.counts{margin-top:4px;white-space:normal}.gold{display:block}.modal{padding:4px} }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div><h1>${escapeHtml(title)} · 전 91페이지</h1><p class="lead">과거 실패·애매·퇴행 감시 페이지를 한 장도 빼지 않은 고정 세트다. 빨간 사각형은 일반 대사만 표시한다. 효과음 박스는 판정과 화면에서 모두 제외했다. 전체 페이지와 각 일반 대사 bbox 확대본을 누르면 원본 크기로 다시 볼 수 있다.</p></div>
      <aside class="version"><small>후보 버전</small><strong>${escapeHtml(args.version)}</strong><span>실험 ${args.experiment} / 최소 ${suite.minimumExperiments} · 최대 ${suite.maximumExperiments}</span></aside>
    </section>
    <p class="warning"><strong>승격 아님:</strong> 실험 1은 v0.8의 알려진 결함을 그대로 재현하는 기준선이다. P055 결합 실패를 고치되, 사용자가 승인한 P070 꼬리 수리와 P080 분리는 반드시 보존해야 한다.</p>
    <nav class="anchors">
      <a class="anchor" href="#P055"><strong>P055 · 합치면 실패</strong><span>두 말풍선 분리 + 빌려온 꼬리 제거</span></a>
      <a class="anchor" href="#P070"><strong>P070 · 사용자 승인 정답</strong><span>긴 오검출 꼬리만 제거</span></a>
      <a class="anchor" href="#P080"><strong>P080 · 합치면 실패</strong><span>이어진 두 말풍선 독립 유지</span></a>
    </nav>
    <div class="toolbar"><input id="search" type="search" placeholder="P055, campaign-006, must-separate 등"><select id="campaign"><option value="">전체 캠페인</option>${campaignOptions}</select><button id="open-bboxes" type="button">표시 중 bbox 모두 열기</button><button id="close-bboxes" type="button">모두 닫기</button><span id="visible" class="summary"></span></div>
    <section id="pages" class="page-grid">${pageCards}</section>
    <footer>생성 ${escapeHtml(generatedAt)} · suite digest <code>${escapeHtml(
      suite.suiteDigest,
    )}</code> · HayaiOCR ${escapeHtml(baseline.ocr.device)}/${escapeHtml(
      baseline.ocr.gpuBackend,
    )} · 일반 대사 ${baseline.summary.dialogueCount} · 내장 전체 페이지 ${views.length}장 · 내장 bbox 확대본 ${imageCounts.bbox}장 · ${formatNumber(
      embeddedJpegBytes / 1024 / 1024,
      1,
    )} MiB</footer>
  </main>
  <div id="modal" class="modal" role="dialog" aria-modal="true"><img id="modal-image" alt="전체 페이지 확대"></div>
  <script id="image-data" type="application/json">${imageJson}</script>
  <script>
    (() => {
      const images = JSON.parse(document.getElementById("image-data").textContent);
      const hydrate = (image) => { const key=image.dataset.image; if(key && !image.src) image.src=images[key]; };
      const observer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => { for(const entry of entries){ if(entry.isIntersecting){ hydrate(entry.target); observer.unobserve(entry.target); } } }, {rootMargin:"1000px"}) : null;
      document.querySelectorAll("img[data-image]").forEach((image) => observer ? observer.observe(image) : hydrate(image));
      const modal=document.getElementById("modal"), modalImage=document.getElementById("modal-image");
      document.querySelectorAll("[data-zoom]").forEach((button) => button.addEventListener("click", () => { modalImage.src=images[button.dataset.zoom]; modal.classList.add("open"); document.body.style.overflow="hidden"; }));
      const close=()=>{modal.classList.remove("open");modalImage.removeAttribute("src");document.body.style.overflow="";}; modal.addEventListener("click",close); addEventListener("keydown",(event)=>{if(event.key==="Escape")close();});
      const search=document.getElementById("search"), campaign=document.getElementById("campaign"), visible=document.getElementById("visible");
      const filter=()=>{const query=search.value.trim().toLocaleLowerCase("ko-KR");let count=0;document.querySelectorAll(".page-card").forEach((card)=>{const show=(!query||card.dataset.search.includes(query))&&(!campaign.value||card.dataset.campaign===campaign.value);card.hidden=!show;if(show)count+=1;});visible.textContent=count+" / "+document.querySelectorAll(".page-card").length+"페이지";};
      search.addEventListener("input",filter);campaign.addEventListener("change",filter);
      document.getElementById("open-bboxes").addEventListener("click",()=>document.querySelectorAll(".page-card:not([hidden]) details").forEach((details)=>{details.open=true;}));
      document.getElementById("close-bboxes").addEventListener("click",()=>document.querySelectorAll("details").forEach((details)=>{details.open=false;}));
      filter();
    })();
  </script>
</body>
</html>`;

  if (imageCounts.page !== suite.pages.length) {
    throw new Error("Not every suite page was embedded.");
  }
  if (imageCounts.bbox !== baseline.summary.dialogueCount) {
    throw new Error(
      `Not every ordinary bbox was embedded: ${imageCounts.bbox}/${baseline.summary.dialogueCount}.`,
    );
  }
  if (Object.keys(imageData).length !== imageCounts.page + imageCounts.bbox) {
    throw new Error("Embedded image registry count is inconsistent.");
  }
  if ((html.match(/class="page-card"/gu) ?? []).length !== suite.pages.length) {
    throw new Error("Not every suite page has one page card.");
  }
  if ((html.match(/<img[^>]+src=/gu) ?? []).length !== 0) {
    throw new Error("Report contains a non-hydrated image source.");
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, html, "utf8");
  const reportBytes = fs.readFileSync(args.output);
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    output: relativeToRepo(args.output),
    byteSize: reportBytes.length,
    sha256: crypto.createHash("sha256").update(reportBytes).digest("hex"),
    suiteDigest: suite.suiteDigest,
    experiment: args.experiment,
    version: args.version,
    pageCardCount: views.length,
    embeddedFullPageImageCount: imageCounts.page,
    embeddedOrdinaryBboxImageCount: imageCounts.bbox,
    embeddedImageCount: Object.keys(imageData).length,
    sourceHashVerifiedCount,
    ordinaryBboxCount: baseline.summary.dialogueCount,
    effectRegionsRendered: 0,
    externalImageSrcCount: 0,
  };
  const manifestPath = `${args.output}.manifest.json`;
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
  .then(() => buildReport(args))
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

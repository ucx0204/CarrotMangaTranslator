#!/usr/bin/env node
/* eslint-disable -- isolated sealed regression-suite builder */
// @ts-nocheck -- laboratory artifact generator, not production code.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const labRoot = path.join(repoRoot, "artifacts", "font-size-ai-lab");
const outputRoot = path.join(labRoot, "failure-balloon-regression-001");
const mangaRoot = path.resolve(
  "C:/Users/sam40/AppData/Local/Tachidesk/downloads/mangas",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function relativeRepo(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function sourceCampaignForGeometryPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const suffixRegression = normalized.match(
    /\/campaign-(\d{3})-regression(?:\/|$)/u,
  );
  if (suffixRegression) return `campaign-${suffixRegression[1]}`;
  const regression = normalized.match(/regression-campaign-(\d{3})/u);
  if (regression) return `campaign-${regression[1]}`;
  const campaign = normalized.match(/campaign-(\d{3})/u);
  if (!campaign) throw new Error(`Cannot infer campaign from ${filePath}`);
  return `campaign-${campaign[1]}`;
}

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filePath, output);
    else output.push(filePath);
  }
  return output;
}

const selections = new Map();
for (let index = 1; index <= 9; index += 1) {
  const campaign = `campaign-${String(index).padStart(3, "0")}`;
  const selectionPath = path.join(labRoot, campaign, "selection.json");
  selections.set(campaign, {
    path: selectionPath,
    value: readJson(selectionPath),
  });
}

const cases = new Map();

function addCase(campaign, pageId, reason, evidence, tags = []) {
  if (!selections.has(campaign)) {
    throw new Error(`Unknown source campaign: ${campaign}`);
  }
  if (!/^P\d{3}$/u.test(pageId)) {
    throw new Error(`Invalid source page id: ${campaign}/${pageId}`);
  }
  const key = `${campaign}/${pageId}`;
  const record = cases.get(key) ?? {
    sourceCampaign: campaign,
    sourcePageId: pageId,
    reasons: [],
    evidence: [],
    tags: [],
  };
  if (reason && !record.reasons.includes(reason)) record.reasons.push(reason);
  if (evidence && !record.evidence.includes(evidence)) {
    record.evidence.push(evidence);
  }
  for (const tag of tags) {
    if (!record.tags.includes(tag)) record.tags.push(tag);
  }
  cases.set(key, record);
}

// Every page whose ordinary-text geometry was changed, fragment-merged, or
// rejected in any recorded geometry experiment is included. Regression roots
// are attributed back to the source campaign rather than the campaign that ran
// the replay.
const geometryFiles = walk(labRoot).filter(
  (filePath) =>
    path.basename(filePath) === "geometry-evaluation.json" &&
    /campaign-00[1-9]/u.test(filePath),
);
for (const filePath of geometryFiles.sort()) {
  const evaluation = readJson(filePath);
  if (!Array.isArray(evaluation.pages)) continue;
  const campaign = sourceCampaignForGeometryPath(filePath);
  for (const page of evaluation.pages) {
    const diagnostics = page.diagnostics ?? {};
    const changed =
      Number(page.changedCount ?? 0) > 0 ||
      (Array.isArray(page.matches) &&
        page.matches.some((item) => item.changed));
    const fragmentMerged = Number(diagnostics.dialogueFragmentMerges ?? 0) > 0;
    const dialogueRejected = Number(diagnostics.rejectedDialogueCount ?? 0) > 0;
    if (!changed && !fragmentMerged && !dialogueRejected) continue;
    const modes = [
      ...(changed ? ["changed ordinary-text geometry"] : []),
      ...(fragmentMerged ? ["fragment merge"] : []),
      ...(dialogueRejected ? ["ordinary-text rejection"] : []),
    ];
    addCase(
      campaign,
      page.pageId,
      `Recorded geometry experiment: ${modes.join(", ")}.`,
      relativeRepo(filePath),
      [
        "geometry-history",
        ...(fragmentMerged ? ["merge-sentinel"] : []),
        ...(dialogueRejected ? ["rejection-sentinel"] : []),
      ],
    );
  }
}

// Direct visual audits are authoritative for named ordinary-text defects even
// when a geometry replay did not mutate that page.
const auditSpecs = [
  [
    "campaign-001",
    "exp-01-production-baseline/visual-audit.json",
    ["severeDialogueGeometry"],
  ],
  ["campaign-002", "visual-audit.json", ["dialogueGeometryFindings"]],
  ["campaign-003", "visual-audit.json", ["dialogueGeometryFindings"]],
  ["campaign-004", "visual-audit.json", ["dialogueGeometryFindings"]],
  ["campaign-005", "visual-audit.json", ["dialogueGeometryFindings"]],
  ["campaign-006", "visual-audit.json", ["geometryFindings"]],
];
for (const [campaign, relative, fields] of auditSpecs) {
  const filePath = path.join(labRoot, campaign, relative);
  const audit = readJson(filePath);
  for (const field of fields) {
    for (const finding of audit[field] ?? []) {
      addCase(
        campaign,
        finding.pageId,
        `${finding.kind ?? "ordinary-text geometry finding"}: ${finding.note ?? "direct visual audit finding"}`,
        relativeRepo(filePath),
        [
          "direct-visual-finding",
          `historic-status-${String(finding.status ?? "open")}`,
        ],
      );
    }
  }
}

// The rejected parent+child partition trial is important even on pages where a
// later accepted replay returned to exact parity.
{
  const filePath = path.join(
    labRoot,
    "campaign-002",
    "preflight-r2-locked-regression.json",
  );
  const preflight = readJson(filePath);
  for (const pageId of preflight.failedReplay.changedPages) {
    addCase(
      "campaign-001",
      pageId,
      "Rejected empty-valley graph retained a broad parent and overlapping child regions.",
      relativeRepo(filePath),
      ["parent-child-duplicate-sentinel", "rejected-experiment"],
    );
  }
}

// Campaign 009 explicitly catalogued same-bubble pairs, including false-merge
// negatives and unresolved audits, across earlier campaigns.
{
  const filePath = path.join(
    labRoot,
    "campaign-009",
    "light-corridor-analysis.json",
  );
  const analysis = readJson(filePath);
  const rows = Array.isArray(analysis)
    ? analysis
    : (analysis.cases ?? analysis.rows ?? analysis.pairs ?? []);
  for (const row of rows) {
    const number = String(row.set ?? "").match(/^c(\d{3})$/u)?.[1];
    if (!number) continue;
    addCase(
      `campaign-${number}`,
      row.pageId,
      `Shared-bubble pair ${row.pair} was catalogued as '${row.verdict}' and must be re-audited without trusting shared white area.`,
      relativeRepo(filePath),
      ["shared-bubble-pair", `historic-${row.verdict}`],
    );
  }
}

// Open ordinary-text / typography failures carried forward by the memory note.
// They remain secondary to geometry but must be visible in every whole-page
// checkpoint so a geometry gain cannot hide a font-size regression.
const carriedTypographyPages = {
  "campaign-003": ["P003", "P004", "P005", "P008", "P010", "P013"],
  "campaign-004": ["P004", "P007", "P009", "P010"],
  "campaign-005": [
    "P002",
    "P003",
    "P004",
    "P008",
    "P009",
    "P011",
    "P012",
    "P013",
    "P020",
    "P021",
    "P022",
    "P023",
  ],
  "campaign-006": [
    "P005",
    "P006",
    "P007",
    "P008",
    "P009",
    "P010",
    "P011",
    "P013",
    "P014",
    "P016",
    "P018",
  ],
  "campaign-007": ["P006", "P008", "P009", "P016", "P017"],
  "campaign-008": [
    "P001",
    "P002",
    "P006",
    "P007",
    "P008",
    "P009",
    "P012",
    "P015",
    "P017",
  ],
  "campaign-009": [
    "P004",
    "P006",
    "P008",
    "P014",
    "P019",
    "P021",
    "P022",
    "P025",
    "P028",
    "P029",
    "P031",
  ],
};
for (const [campaign, pageIds] of Object.entries(carriedTypographyPages)) {
  for (const pageId of pageIds) {
    addCase(
      campaign,
      pageId,
      "Carried ordinary-text geometry/font-size failure or no-regression sentinel from the distilled memory note.",
      "docs/font-size-ai-lab-memory.md",
      ["typography-visible-check"],
    );
  }
}

// User-confirmed labels override every earlier automated or Codex judgment.
addCase(
  "campaign-006",
  "P005",
  "USER GOLD 2026-09-03: T006 and T020 belong to two touching speech balloons. Keep two regions; trim T006's borrowed detached tail instead of joining them.",
  "docs/font-size-ai-lab-memory.md",
  ["user-gold", "must-separate", "borrowed-mask-tail"],
);
{
  const corrected = cases.get("campaign-006/P005");
  corrected.reasons = corrected.reasons.map((reason) =>
    reason.startsWith("same-balloon-vertical-fragmentation:")
      ? `SUPERSEDED HISTORICAL LABEL (user correction): ${reason}`
      : reason,
  );
  corrected.tags = corrected.tags.filter((tag) => tag !== "fixed-v0.6.0");
  corrected.tags.push("historic-v0.6-label-rejected");
}
addCase(
  "campaign-007",
  "P017",
  "USER GOLD 2026-09-03: the local tail-repaired result is correct. Preserve the number of utterances and remove only the page-spanning mask tail.",
  "docs/font-size-ai-lab-memory.md",
  ["user-gold", "positive-anchor", "tail-repair"],
);
addCase(
  "campaign-009",
  "P004",
  "USER GOLD 2026-09-03: touching speech balloons must remain separate; the v0.9 T003+T006 union is forbidden.",
  "docs/font-size-ai-lab-memory.md",
  ["user-gold", "must-separate", "touching-balloons"],
);

// Direct user review of the first fixed-suite checkpoint. These labels are
// stronger than historical experiment verdicts. A page may be a positive
// separation sentinel, a geometry-repair target, or explicitly neutral.
const checkpointUserGold = [
  {
    campaign: "campaign-001",
    pageId: "P017",
    reason:
      "USER GOLD 2026-09-03 #1: D008 ('まだピンときていないみたいね') and D010 ('たとえば...') are separate text blocks. Preserve the v0.8 separation; never union them into one large box.",
    tags: ["must-separate", "positive-v0.8-sentinel"],
  },
  {
    campaign: "campaign-001",
    pageId: "P019",
    reason:
      "USER GOLD 2026-09-03 #2: D006 ('ね?言葉だけじゃ伝わらないでしょ?') and D007 (the longer actor/voice passage) must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel"],
  },
  {
    campaign: "campaign-001",
    pageId: "P023",
    reason:
      "USER GOLD 2026-09-03 #3: D006 and D007 are correctly separated, but D006 extends too far down through the empty middle area. Keep two blocks and trim only the contaminated lower extent of D006.",
    tags: ["must-separate", "bbox-trim-target", "preserve-block-count"],
  },
  {
    campaign: "campaign-001",
    pageId: "P032",
    reason:
      "USER GOLD 2026-09-03 #4: the shown D002 multi-column region may remain joined or be split; either result is acceptable and must not decide an experiment by itself.",
    tags: ["user-neutral", "non-decisive"],
  },
  {
    campaign: "campaign-002",
    pageId: "P013",
    reason:
      "USER GOLD 2026-09-03 #5: D001 is an overlapping page-spanning box whose lower extent runs far beyond its local content. Repair the long tail/extent instead of retaining the overlap.",
    tags: ["bbox-trim-target", "overlap-defect", "page-spanning-tail"],
  },
  {
    campaign: "campaign-002",
    pageId: "P031",
    reason:
      "USER GOLD 2026-09-03 #6: D004 and D006 belong to separate touching balloons and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-003",
    pageId: "P003",
    reason:
      "USER GOLD 2026-09-03 #7: D001 and D003 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-003",
    pageId: "P003",
    reason:
      "USER GOLD 2026-09-03 #8: D009 currently spans two vertically separated text clusters. Split the clusters rather than keeping one tall union box.",
    tags: ["must-split", "multi-cluster-region", "v0.8-open-defect"],
  },
  {
    campaign: "campaign-003",
    pageId: "P004",
    reason:
      "USER GOLD 2026-09-03 #9: keep D001 and D002 as distinct utterances, but refine their local bbox boundaries; the current edge placement is visibly imprecise.",
    tags: ["must-separate", "bbox-boundary-target"],
  },
  {
    campaign: "campaign-003",
    pageId: "P005",
    reason:
      "USER GOLD 2026-09-03 #10: D002 and D004 each contain visibly separated dialogue clusters in oversized boxes. Partition the clusters; do not use a union box as the repair.",
    tags: ["must-split", "multi-cluster-region", "v0.8-open-defect"],
  },
];
for (const item of checkpointUserGold) {
  addCase(
    item.campaign,
    item.pageId,
    item.reason,
    "docs/font-size-ai-lab-memory.md",
    ["user-gold", "checkpoint-exp-01-review", ...item.tags],
  );
}

const checkpointUserGoldBatch2 = [
  {
    campaign: "campaign-003",
    pageId: "P013",
    reason:
      "USER GOLD 2026-09-03 B2#1: D003 and D004 are separate narration blocks. Preserve the v0.8 separation; the v0.9 union is forbidden.",
    tags: ["must-separate", "positive-v0.8-sentinel"],
  },
  {
    campaign: "campaign-003",
    pageId: "P013",
    reason:
      "USER GOLD 2026-09-03 B2#2: keep D008 and D011 separate and improve their tight local boundaries; the current narrow adjacent boxes are visibly imprecise.",
    tags: ["must-separate", "bbox-boundary-target"],
  },
  {
    campaign: "campaign-003",
    pageId: "P013",
    reason:
      "USER NOTE 2026-09-03 B2#3: the undetected handwritten dessert text would be useful if recovered, but it is explicitly low priority and cannot decide acceptance.",
    tags: ["low-priority", "non-decisive", "uncovered-text"],
  },
  {
    campaign: "campaign-004",
    pageId: "P004",
    reason:
      "USER GOLD 2026-09-03 B2#4: D001/D002 are two touching-balloon blocks, but the current boundary cuts through the lower text. Repartition the local pixels correctly and never union the two utterances.",
    tags: ["must-separate", "bbox-boundary-target", "touching-balloons"],
  },
  {
    campaign: "campaign-004",
    pageId: "P007",
    reason:
      "USER GOLD 2026-09-03 B2#5: D001 extends visibly too far downward. Trim the lower extent while preserving the local utterance.",
    tags: ["bbox-trim-target", "preserve-block-count"],
  },
  {
    campaign: "campaign-004",
    pageId: "P009",
    reason:
      "USER GOLD 2026-09-03 B2#6: upper D002/D003 must remain separate, and lower D006 must be partitioned into its two visible dialogue clusters. Both shown unions are forbidden.",
    tags: ["must-separate", "must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-004",
    pageId: "P010",
    reason:
      "USER GOLD 2026-09-03 B2#7: D001 contains two separated utterance clusters and must be partitioned instead of kept as one union bbox.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-004",
    pageId: "P010",
    reason:
      "USER GOLD 2026-09-03 B2#8: both D003 and D004 contain separated upper/lower dialogue clusters. Partition both regions; do not retain either tall union bbox.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-005",
    pageId: "P008",
    reason:
      "USER GOLD 2026-09-03 B2#9: D002 and D003 are correctly separate, but D002's left boundary intrudes into D003. Preserve two blocks and make their bboxes mutually exclusive.",
    tags: ["must-separate", "bbox-boundary-target", "overlap-defect"],
  },
  {
    campaign: "campaign-005",
    pageId: "P009",
    reason:
      "USER NOTE 2026-09-03 B2#10: splitting D004's heading/name from its explanatory lines is desirable but explicitly low priority and cannot decide acceptance.",
    tags: ["low-priority", "non-decisive", "optional-split"],
  },
];

const checkpointUserGoldBatch3 = [
  {
    campaign: "campaign-005",
    pageId: "P011",
    reason:
      "USER GOLD 2026-09-03 B3#1: D007 contains two separated speech clusters and must be partitioned instead of retained as one large union bbox.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-006",
    pageId: "P006",
    reason:
      "USER GOLD 2026-09-03 B3#2: D006 and D008 are separate touching-balloon utterances. Preserve the v0.8 separation; union is forbidden.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-006",
    pageId: "P008",
    reason:
      "USER GOLD 2026-09-03 B3#3: D008 and D011 are separate touching-balloon utterances. Preserve the v0.8 separation; union is forbidden.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-006",
    pageId: "P009",
    reason:
      "USER GOLD 2026-09-03 B3#4: D011 combines 'ル...ルドルフ殿下!!' and '大変です!!'. Split those visible clusters into separate blocks.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-006",
    pageId: "P009",
    reason:
      "USER GOLD 2026-09-03 B3#5: D006/D008 are correctly separate, but the right D006 bbox intrudes into the left text area. Preserve two blocks and refine the shared boundary.",
    tags: ["must-separate", "bbox-boundary-target", "overlap-defect"],
  },
  {
    campaign: "campaign-006",
    pageId: "P011",
    reason:
      "USER GOLD 2026-09-03 B3#6: D010 contains two vertically separated utterance clusters and must be partitioned.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-006",
    pageId: "P013",
    reason:
      "USER GOLD 2026-09-03 B3#7: D009 and D010 are separate touching-balloon utterances. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-006",
    pageId: "P018",
    reason:
      "USER GOLD 2026-09-03 B3#8: D004 and D006 are separate touching-balloon utterances. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-006",
    pageId: "P018",
    reason:
      "USER GOLD 2026-09-03 B3#9: D007 and D009 are separate touching-balloon utterances. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-007",
    pageId: "P006",
    reason:
      "USER GOLD 2026-09-03 B3#10: split v0.8 D006 back into 'あっ' and 'あいつ生徒会の...っ'; also keep D007 'おい' separate from D008. This supersedes the former v0.8 positive rejoin label.",
    tags: [
      "must-split",
      "must-separate",
      "former-v0.8-positive-rejected",
      "fragment-rejoin-sentinel",
    ],
  },
];

const checkpointUserGoldBatch4 = [
  {
    campaign: "campaign-007",
    pageId: "P016",
    reason:
      "USER GOLD 2026-09-03 B4#1: split D001 into 'それもそうか' and 'ラスボスみたいなもんだもんね!'. The single union bbox is forbidden.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-007",
    pageId: "P017",
    reason:
      "USER GOLD 2026-09-03 B4#2: split v0.8 D011 back into 'ひどい...' and '一体誰がこんな事を!?'. This supersedes the former fragment-rejoin positive label.",
    tags: [
      "must-split",
      "former-v0.8-positive-rejected",
      "fragment-rejoin-sentinel",
    ],
  },
  {
    campaign: "campaign-007",
    pageId: "P017",
    reason:
      "USER GOLD 2026-09-03 B4#3: D014 'ま...' and D015 'まて!' must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel"],
  },
  {
    campaign: "campaign-008",
    pageId: "P001",
    reason:
      "USER GOLD 2026-09-03 B4#4: D008 and D009 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-008",
    pageId: "P002",
    reason:
      "USER GOLD 2026-09-03 B4#5: D002 '彼女' and D003 'リズベット殿と婚約したことで' are separate blocks and must remain separate.",
    tags: ["must-separate", "positive-v0.8-sentinel"],
  },
  {
    campaign: "campaign-008",
    pageId: "P007",
    reason:
      "USER GOLD 2026-09-03 B4#6: D005 and D006 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-008",
    pageId: "P009",
    reason:
      "USER GOLD 2026-09-03 B4#7: split D004 between the upper 'アリシア妃殿下が...' passage and lower 'むしろこれ以上...' passage. One tall union bbox is forbidden.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "campaign-008",
    pageId: "P012",
    reason:
      "USER GOLD 2026-09-03 B4#8: D001 and D002 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-008",
    pageId: "P015",
    reason:
      "USER GOLD 2026-09-03 B4#9: split v0.8 D005 back into '殿下' and 'ご自分に価値がないなんて思わないでください'. This supersedes the former fragment-rejoin positive label.",
    tags: [
      "must-split",
      "former-v0.8-positive-rejected",
      "fragment-rejoin-sentinel",
    ],
  },
  {
    campaign: "campaign-009",
    pageId: "P004",
    reason:
      "USER GOLD 2026-09-03 B4#10: D002 '...ちょっとまずいわね' and D003 '神器' are separate touching-balloon utterances and must remain separate.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
];

const checkpointUserGoldBatch5 = [
  {
    campaign: "campaign-009",
    pageId: "P006",
    reason:
      "USER GOLD 2026-09-03 B5#1: D001/D002 are fragments of one utterance ('戦いが長引けばこっちが持ちませんよっ!') and must be joined, while repairing the visibly wrong overlapping geometry.",
    tags: ["must-merge", "positive-merge-anchor", "bbox-boundary-target"],
  },
  {
    campaign: "campaign-009",
    pageId: "P006",
    reason:
      "USER GOLD 2026-09-03 B5#2: D005 and D006 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-009",
    pageId: "P014",
    reason:
      "USER GOLD 2026-09-03 B5#3: D002 and D003 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-009",
    pageId: "P019",
    reason:
      "USER GOLD 2026-09-03 B5#4: D002 and D003 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-009",
    pageId: "P021",
    reason:
      "USER GOLD 2026-09-03 B5#5: D001 and D003 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "campaign-009",
    pageId: "P031",
    reason:
      "USER GOLD 2026-09-03 B5#6: D002 and D003 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "fixed-diagnostic",
    pageId: "P004",
    reason:
      "USER GOLD 2026-09-03 B5#7: split D001 between 'あれ?' and '私たち地下に潜ってたッスよね?'. One union bbox is forbidden.",
    tags: ["must-split", "multi-cluster-region"],
  },
  {
    campaign: "fixed-diagnostic",
    pageId: "P004",
    reason:
      "USER GOLD 2026-09-03 B5#8: D004 and D005 are separate touching-balloon utterances and must remain separate. Preserve the v0.8 separation.",
    tags: ["must-separate", "positive-v0.8-sentinel", "touching-balloons"],
  },
  {
    campaign: "fixed-diagnostic",
    pageId: "P004",
    reason:
      "USER GOLD 2026-09-03 B5#9: D006 and D008 are a correctly separated model example. Preserve their independent bboxes and block count.",
    tags: ["must-separate", "positive-anchor", "model-separation"],
  },
];

for (const item of [
  ...checkpointUserGoldBatch2,
  ...checkpointUserGoldBatch3,
  ...checkpointUserGoldBatch4,
  ...checkpointUserGoldBatch5,
]) {
  if (item.campaign === "fixed-diagnostic") continue;
  addCase(
    item.campaign,
    item.pageId,
    item.reason,
    "docs/font-size-ai-lab-memory.md",
    ["user-gold", "checkpoint-exp-01-review", ...item.tags],
  );
}

const orderedCases = [...cases.values()].sort(
  (left, right) =>
    left.sourceCampaign.localeCompare(right.sourceCampaign) ||
    left.sourcePageId.localeCompare(right.sourcePageId),
);

const suitePages = orderedCases.map((record, index) => {
  const selection = selections.get(record.sourceCampaign).value;
  const sourceIndex = Number(record.sourcePageId.slice(1));
  const sourcePage = selection.pages.find(
    (page) => Number(page.index) === sourceIndex,
  );
  if (!sourcePage) {
    throw new Error(
      `Missing source page ${record.sourceCampaign}/${record.sourcePageId}`,
    );
  }
  const resolvedPath = path.resolve(sourcePage.path);
  if (
    resolvedPath !== mangaRoot &&
    !resolvedPath.startsWith(`${mangaRoot}${path.sep}`)
  ) {
    throw new Error(`Source escaped manga root: ${resolvedPath}`);
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing original source page: ${resolvedPath}`);
  }
  const currentSha = sha256File(resolvedPath);
  if (currentSha !== sourcePage.sha256) {
    throw new Error(
      `Original page hash drifted: ${record.sourceCampaign}/${record.sourcePageId}`,
    );
  }
  return {
    suitePageId: `P${String(index + 1).padStart(3, "0")}`,
    sourceCampaign: record.sourceCampaign,
    sourcePageId: record.sourcePageId,
    chapterKey: selection.key,
    sourceName: sourcePage.name,
    path: resolvedPath,
    byteSize: sourcePage.byteSize,
    sha256: currentSha,
    reasons: record.reasons.sort(),
    evidence: record.evidence.sort(),
    tags: record.tags.sort(),
  };
});

// The original user diagnostic that started the campaign is also a real manga
// page and is included as a fixed source-size/geometry sentinel.
{
  const fixedPath = path.join(
    mangaRoot,
    "RawINU (JA)",
    "BUCHI KIRE REIJO HA HOFUKU WO CHIKAIMASHITA. MA SHIRUBE SHO NO CHIKARA",
    "Chapter 31",
    "004.jpg",
  );
  if (!fs.existsSync(fixedPath)) {
    throw new Error(`Missing fixed diagnostic source: ${fixedPath}`);
  }
  const existing = suitePages.find((page) => page.path === fixedPath);
  const fixedUserGold = checkpointUserGoldBatch5.filter(
    (item) => item.campaign === "fixed-diagnostic",
  );
  if (!existing) {
    const bytes = fs.statSync(fixedPath).size;
    suitePages.push({
      suitePageId: `P${String(suitePages.length + 1).padStart(3, "0")}`,
      sourceCampaign: "fixed-diagnostic",
      sourcePageId: "P004",
      chapterKey:
        "RawINU (JA)/BUCHI KIRE REIJO HA HOFUKU WO CHIKAIMASHITA. MA SHIRUBE SHO NO CHIKARA/Chapter 31",
      sourceName: "004.jpg",
      path: fixedPath,
      byteSize: bytes,
      sha256: sha256File(fixedPath),
      reasons: [
        "Original fixed diagnostic: a multi-column ordinary speech region lost source-size geometry and fell back to 12px.",
        ...fixedUserGold.map((item) => item.reason),
      ],
      evidence: ["docs/font-size-ai-lab-memory.md"],
      tags: [
        "fixed-diagnostic",
        "typography-visible-check",
        "user-gold",
        "checkpoint-exp-01-review",
        ...new Set(fixedUserGold.flatMap((item) => item.tags)),
      ].sort(),
    });
  } else {
    for (const item of fixedUserGold) {
      if (!existing.reasons.includes(item.reason))
        existing.reasons.push(item.reason);
      for (const tag of [
        "user-gold",
        "checkpoint-exp-01-review",
        ...item.tags,
      ]) {
        if (!existing.tags.includes(tag)) existing.tags.push(tag);
      }
    }
    existing.reasons.sort();
    existing.tags.sort();
  }
}

const sourceSelectionDigests = Object.fromEntries(
  [...selections.entries()].map(([campaign, selection]) => [
    campaign,
    sha256File(selection.path),
  ]),
);
const frozenPayload = suitePages.map((page) => ({
  suitePageId: page.suitePageId,
  sourceCampaign: page.sourceCampaign,
  sourcePageId: page.sourcePageId,
  path: page.path,
  sha256: page.sha256,
  reasons: page.reasons,
  evidence: page.evidence,
  tags: page.tags,
}));
const suiteDigest = sha256Bytes(Buffer.from(stableJson(frozenPayload)));
const generatedAt = new Date().toISOString();

const manifest = {
  schemaVersion: 1,
  suite: "all-known-ordinary-text-balloon-failures-2026-09-03",
  generatedAt,
  status: "sealed-for-10-to-30-iteration-regression",
  baselineVersion: "fsai-lab-v0.8.0-known-imperfect",
  sourceRoot: mangaRoot,
  sourceReadOnly: true,
  effectBoxesExcluded: true,
  pageCount: suitePages.length,
  suiteDigest,
  checkpointExperiments: [1, 5, 10, 15, 20, 25, 30],
  minimumExperiments: 10,
  maximumExperiments: 30,
  userHardInvariants: [
    "Two touching speech balloons remain separate.",
    "Do not repair an oversized or contaminated bbox by joining it to a neighboring utterance.",
    "Trim or partition borrowed mask pixels while preserving utterance count.",
    "Campaign 006 P005 T006 and T020 remain separate.",
    "Campaign 009 P004 T003 and T006 remain separate.",
    "Campaign 007 P017 retains the approved local tail repair.",
    "Checkpoint #1/#2/#6/#7 v0.8-separated pairs remain separate.",
    "Checkpoint #3/#5/#9 repair bbox extent without joining neighbors.",
    "Checkpoint #8/#10 separated text clusters must not remain in one union bbox.",
    "Checkpoint #4 is user-neutral and cannot decide acceptance.",
    "All direct checkpoint batches B2 and B3 are hard labels except rows explicitly tagged low-priority/non-decisive.",
    "Campaign 007 P006 v0.8 D006 must split; its historical fragment-rejoin success label is superseded.",
    "Campaign 007 P017 D011 and Campaign 008 P015 D005 must also split; all three former v0.8 fragment-rejoin positives are superseded.",
    "Campaign 009 P006 D001/D002 is the direct positive merge anchor; do not replace selective joining with a blanket no-merge rule.",
    "Fixed diagnostic P004 D006/D008 is the direct model-separation anchor.",
    "Effect/SFX boxes do not affect acceptance.",
  ],
  sourceSelectionDigests,
  pages: suitePages,
};

const selection = {
  schemaVersion: 1,
  campaign: "font-size-ai-hayai-ocr-fixed-failure-suite",
  sealedAt: generatedAt,
  seed: null,
  key: "fixed-regression/all-known-ordinary-text-balloon-failures/2026-09-03",
  normalizedKey:
    "fixed-regression/all-known-ordinary-text-balloon-failures/2026-09-03",
  provider: "mixed-sealed-history",
  series: "all-known-failure-pages",
  chapter: "fixed-regression-001",
  path: mangaRoot,
  pageCount: suitePages.length,
  pages: suitePages.map((page, index) => ({
    byteSize: page.byteSize,
    index: index + 1,
    name: `${page.sourceCampaign}-${page.sourcePageId}-${page.sourceName}`,
    path: page.path,
    sha256: page.sha256,
  })),
  experimentsUsed: 0,
  experimentLimit: 30,
  minimumExperiments: 10,
  status: "sealed",
  suiteDigest,
};

fs.mkdirSync(outputRoot, { recursive: true });
const manifestPath = path.join(outputRoot, "suite-manifest.json");
const selectionPath = path.join(outputRoot, "selection.json");
fs.writeFileSync(manifestPath, stableJson(manifest), "utf8");
fs.writeFileSync(selectionPath, stableJson(selection), "utf8");

console.log(
  JSON.stringify(
    {
      outputRoot,
      manifestPath,
      selectionPath,
      pageCount: suitePages.length,
      suiteDigest,
      campaignCounts: Object.fromEntries(
        [...new Set(suitePages.map((page) => page.sourceCampaign))].map(
          (campaign) => [
            campaign,
            suitePages.filter((page) => page.sourceCampaign === campaign)
              .length,
          ],
        ),
      ),
    },
    null,
    2,
  ),
);

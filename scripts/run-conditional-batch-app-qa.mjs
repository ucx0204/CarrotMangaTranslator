/* eslint-disable @typescript-eslint/ban-ts-comment -- this runner validates dynamic Electron and CDP contracts at runtime */
// @ts-nocheck -- CDP, Electron, and compiled production-module contracts are asserted dynamically by this isolated QA runner.
/* eslint-disable max-lines -- Electron launch, UI driving, persistence comparison, and cleanup form one end-to-end QA boundary */
import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  CdpClient,
  evaluateJson,
  formatExceptionDetails,
  waitForPageTarget,
} from "./ui-qa/cdp-client.mjs";
import {
  appendLog,
  captureLogs,
  delay,
  findAvailablePort,
  stopProcess,
} from "./ui-qa/process-utils.mjs";
import { createConditionalBatchAppFixture } from "./conditional-batch-app-qa/fixture.mjs";

const require = createRequire(import.meta.url);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const artifactRoot = join(
  sourceRoot,
  ".tmp",
  "conditional-batch-app-qa",
  runStamp,
);
const appRoot = join(artifactRoot, "app-root");
const reportPath = join(artifactRoot, "report.json");
const appStdoutPath = join(artifactRoot, "electron-output.log");
const keepAppRoot = process.argv.includes("--keep-app-root");
const operationTimeoutMs = 35_000;

let electronProcess = null;
let cdp = null;
let electronOutput = "";
const rendererExceptions = [];
const rendererErrors = [];
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  sourceRoot,
  artifactRoot,
  appSurface: {
    electron: true,
    productionRenderer: true,
    realPreload: true,
    realIpc: true,
    realLibraryPersistence: true,
    isolatedDataRoot: true,
  },
  matrix: null,
  sequences: [],
  runtime: null,
  status: "running",
};

try {
  await main();
  report.status = "passed";
  report.completedAt = new Date().toISOString();
  await writeReport();
  process.stdout.write(
    `[conditional-batch-app-qa] PASS report=${reportPath}\n`,
  );
} catch (error) {
  report.status = "failed";
  report.completedAt = new Date().toISOString();
  report.failure = formatError(error);
  if (cdp) {
    await captureScreenshot("failure.png").catch((screenshotError) => {
      process.stderr.write(
        `[conditional-batch-app-qa] failure screenshot unavailable: ${formatError(screenshotError)}\n`,
      );
    });
  }
  await writeReport().catch((reportError) => {
    process.stderr.write(
      `[conditional-batch-app-qa] failure report unavailable: ${formatError(reportError)}\n`,
    );
  });
  process.stderr.write(`${formatError(error)}\n`);
  process.stderr.write(
    `[conditional-batch-app-qa] FAILED app root kept at ${appRoot}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeApp();
  await writeFile(appStdoutPath, electronOutput, "utf8").catch(
    (stdoutError) => {
      process.stderr.write(
        `[conditional-batch-app-qa] Electron output log unavailable: ${formatError(stdoutError)}\n`,
      );
    },
  );
  if (report.status === "passed" && !keepAppRoot) {
    await removeIsolatedAppRoot();
  }
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  status("preparing isolated production app");
  await stageProductionApp();
  const fixture = await createConditionalBatchAppFixture({
    sourceRoot,
    runRoot: appRoot,
  });
  report.matrix = summarizeMatrix(fixture);

  status("launching Electron with the real preload and IPC bridge");
  const debuggingPort = await findAvailablePort();
  electronProcess = launchElectron(debuggingPort);
  const target = await waitForPageTarget(
    debuggingPort,
    electronProcess,
    operationTimeoutMs,
  );
  // Attaching Runtime while Electron is still installing the sandbox preload
  // can intermittently observe an empty startupData binding. Give the real
  // preload one short, bounded turn before CDP starts driving the page.
  await delay(500);
  cdp = await CdpClient.connect(String(target.webSocketDebuggerUrl));
  installRuntimeDiagnostics(cdp);
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Log.enable"),
  ]);
  await waitForExpression(
    `document.readyState === "complete" && Boolean(window.mangaApi)`,
    "real app renderer and preload bridge",
  );
  report.runtime = await readRuntimeIdentity();

  status("opening the copied library chapter through the visible app UI");
  await clickChapter(fixture.chapterTitle);
  await waitForExpression(
    `document.body.innerText.includes(${JSON.stringify(fixture.chapterTitle)})`,
    "opened QA chapter",
  );
  await openConditionalBatchEditor();
  await selectChapterScope();

  for (const expected of fixture.expectedSequences) {
    const result = await exerciseSequence({ expected, fixture });
    report.sequences.push(result);
  }

  await assertNoRuntimeErrors();
  await assertMainLogHealthy();
  report.summary = {
    combinations: fixture.caseCount,
    conditionFields: new Set(
      fixture.caseInventory
        .filter((entry) => entry.conditionFamily.startsWith("field:"))
        .map((entry) => entry.conditionFamily.slice("field:".length)),
    ).size,
    sequences: fixture.expectedSequences.length,
    totalSteps: fixture.expectedSequences.reduce(
      (total, sequence) => total + sequence.stepResultCounts.length,
      0,
    ),
    applyVerifications: report.sequences.length,
    undoVerifications: report.sequences.length,
  };
}

async function stageProductionApp() {
  await mkdir(join(appRoot, "out"), { recursive: true });
  await Promise.all([
    cp(join(sourceRoot, "out", "main"), join(appRoot, "out", "main"), {
      recursive: true,
    }),
    cp(join(sourceRoot, "out", "preload"), join(appRoot, "out", "preload"), {
      recursive: true,
    }),
    cp(join(sourceRoot, "out", "renderer"), join(appRoot, "out", "renderer"), {
      recursive: true,
    }),
    cp(join(sourceRoot, "out", "shared"), join(appRoot, "out", "shared"), {
      recursive: true,
    }),
    cp(
      join(sourceRoot, "src", "renderer", "src", "assets", "fonts"),
      join(appRoot, "src", "renderer", "src", "assets", "fonts"),
      { recursive: true },
    ),
    copyFile(join(sourceRoot, "package.json"), join(appRoot, "package.json")),
  ]);
  await createJunction(
    join(sourceRoot, "node_modules"),
    join(appRoot, "node_modules"),
  );
  await createOptionalJunction(
    join(sourceRoot, "out", "app-runtime"),
    join(appRoot, "out", "app-runtime"),
  );
  await createOptionalJunction(
    join(sourceRoot, "tools"),
    join(appRoot, "tools"),
  );
}

async function createOptionalJunction(target, path) {
  try {
    await lstat(target);
  } catch (error) {
    void error;
    return;
  }
  await createJunction(target, path);
}

async function createJunction(target, path) {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, "junction");
}

function launchElectron(debuggingPort) {
  const { ensureElectronExecutable } = require("./electron-executable.cjs");
  const electronExecutable = ensureElectronExecutable(sourceRoot);
  const env = {
    ...process.env,
    MANGA_TRANSLATOR_DEV_USER_DATA: join(appRoot, ".tmp", "user-data"),
    MANGA_TRANSLATOR_DEV_SESSION_DATA: join(appRoot, ".tmp", "session-data"),
    MANGA_TRANSLATOR_UI_LOCALE: "ko",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronExecutable,
    [
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${debuggingPort}`,
      "--disable-gpu",
      "--disable-gpu-shader-disk-cache",
      appRoot,
    ],
    {
      cwd: appRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  captureLogs(child, (chunk) => {
    electronOutput = appendLog(electronOutput, chunk);
    const text = String(chunk).trim();
    if (text) process.stdout.write(`[electron] ${text}\n`);
  });
  return child;
}

function installRuntimeDiagnostics(client) {
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    rendererExceptions.push(formatExceptionDetails(exceptionDetails));
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry?.level === "error") rendererErrors.push(String(entry.text));
  });
}

async function readRuntimeIdentity() {
  return evaluateJson(
    cdp,
    `(() => ({
      url: location.href,
      title: document.title,
      hasMangaApi: Boolean(window.mangaApi),
      apiMethods: [
        "getLibrary",
        "openChapter",
        "savePagesBlocks",
        "listConditionalBatchSchemes"
      ].filter((name) => typeof window.mangaApi?.[name] === "function"),
    }))()`,
  );
}

async function clickChapter(chapterTitle) {
  await waitForExpression(
    `Array.from(document.querySelectorAll("button[title]")).some(
      (button) => button.getAttribute("title") === ${JSON.stringify(chapterTitle)}
    )`,
    "QA chapter button",
  );
  const clicked = await evaluateJson(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll("button[title]")).find(
        (candidate) => candidate.getAttribute("title") === ${JSON.stringify(chapterTitle)}
      );
      if (!button) return false;
      button.scrollIntoView({ block: "center" });
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error("Could not click the QA chapter.");
  await waitForExpression(
    `Array.from(document.querySelectorAll(".chapter-item.active button[title]"))
      .some((button) => button.getAttribute("title") === ${JSON.stringify(chapterTitle)})`,
    "active QA chapter",
  );
}

async function openConditionalBatchEditor() {
  await waitForExpression(
    `(() => {
      const button = document.querySelector('button[aria-label="텍스트 모아보기"]');
      return Boolean(button && !button.disabled);
    })()`,
    "enabled gather-text app control",
  );
  const gatherOpened = await evaluateJson(
    cdp,
    `(() => {
      const button = document.querySelector('button[aria-label="텍스트 모아보기"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
  if (!gatherOpened) throw new Error("Could not open the gather-text modal.");
  await waitForExpression(
    `Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent.trim() === "텍스트 일괄 편집" && !button.disabled
    )`,
    "conditional batch entry button",
  );
  await clickExactButton("텍스트 일괄 편집");
  await waitForExpression(
    `Boolean(document.querySelector("[data-conditional-batch-editor]"))`,
    "conditional batch editor",
  );
}

async function selectChapterScope() {
  const scopeVisible = await evaluateJson(
    cdp,
    `Boolean(document.querySelector('[role="radiogroup"][aria-label="적용 범위"]'))`,
  );
  if (!scopeVisible) {
    const recipeClosed = await evaluateJson(
      cdp,
      `(() => {
        const editor = document.querySelector('[data-conditional-batch-editor]');
        const heading = Array.from(editor?.querySelectorAll("strong") ?? [])
          .find((node) => node.textContent.trim() === "새 규칙");
        const panel = heading?.closest("section");
        const buttons = Array.from(panel?.querySelectorAll("button") ?? []);
        const button =
          buttons.find((candidate) => candidate.textContent.trim() === "닫기") ??
          buttons.find(
            (candidate) => candidate.textContent.trim() === "직접 만들기"
          );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`,
    );
    if (!recipeClosed) {
      throw new Error("Could not leave the new-rule recipe picker.");
    }
  }
  await waitForExpression(
    `Boolean(document.querySelector('[role="radiogroup"][aria-label="적용 범위"]'))`,
    "conditional batch scope control",
  );
  const clicked = await evaluateJson(
    cdp,
    `(() => {
      const group = document.querySelector('[role="radiogroup"][aria-label="적용 범위"]');
      const button = Array.from(group?.querySelectorAll('[role="radio"]') ?? [])
        .find((candidate) => candidate.textContent.trim() === "화");
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error("Could not select chapter scope.");
  await waitForExpression(
    `document.querySelector('[role="radiogroup"][aria-label="적용 범위"] [role="radio"][aria-checked="true"]')?.textContent.trim() === "화"`,
    "chapter scope selection",
  );
}

async function exerciseSequence({ expected, fixture }) {
  status(`previewing ${expected.name}`);
  await clickSequencePreview(expected.name);
  await waitForExpression(
    `Array.from(document.querySelectorAll("strong")).some((node) => {
      const section = node.closest("section");
      return node.textContent.trim() === ${JSON.stringify(expected.name)} &&
        Boolean(section?.querySelector("ol")) &&
        section.textContent.includes("규칙 편집으로 돌아가기");
    })`,
    `${expected.name} run card`,
  );
  await waitForResultCount(expected.resultCount);
  const uiStepResultCounts = await readStepResultCounts(expected.name);
  if (!isDeepStrictEqual(uiStepResultCounts, expected.stepResultCounts)) {
    throw new Error(
      `${expected.name} step counts differ: expected ${JSON.stringify(
        expected.stepResultCounts,
      )}, got ${JSON.stringify(uiStepResultCounts)}.`,
    );
  }

  await assertAllIncludeExclude(expected.resultCount);
  if (report.sequences.length === 0) await captureScreenshot();

  status(`applying ${expected.name}`);
  await clickExactButton("연속 실행", "footer");
  const actualAfter = await waitForChapterBlocks(
    fixture.chapterId,
    expected.chapter,
    `${expected.name} persisted apply`,
  );
  const appliedNotice = await readApplyNotice();
  await waitForExpression(
    `Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent.trim() === "실행 취소" && !button.disabled
    )`,
    `${expected.name} undo availability`,
  );

  status(`undoing ${expected.name}`);
  await clickExactButton("실행 취소");
  await waitForChapterBlocks(
    fixture.chapterId,
    fixture.baselineChapter,
    `${expected.name} persisted undo`,
  );
  await clickExactButton("규칙 편집으로 돌아가기");
  await waitForExpression(
    `Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent.trim() === "미리보기"
    )`,
    `${expected.name} return to rule editor`,
  );

  return {
    id: expected.id,
    name: expected.name,
    stepCount: expected.stepResultCounts.length,
    stepResultCounts: uiStepResultCounts,
    combinedResultCount: expected.resultCount,
    appliedBlockCount: countBlocks(actualAfter),
    applyMatchesEngine: true,
    undoRestoredBaseline: true,
    allExcludeDisabledApply: true,
    allIncludeRestoredApply: true,
    notice: appliedNotice,
  };
}

async function clickSequencePreview(sequenceName) {
  const point = await evaluateJson(
    cdp,
    `(() => {
      const heading = Array.from(document.querySelectorAll("strong")).find(
        (node) => node.textContent.trim() === ${JSON.stringify(sequenceName)}
      );
      const row = heading?.parentElement?.parentElement;
      const button = Array.from(row?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent.trim() === "미리보기"
      );
      if (button && !button.disabled) {
        button.scrollIntoView({ block: "center", inline: "center" });
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return null;
    })()`,
  );
  if (!point) throw new Error(`Could not preview sequence ${sequenceName}.`);
  const hitTarget = await evaluateJson(
    cdp,
    `(() => {
      const target = document.elementFromPoint(${Number(point.x)}, ${Number(point.y)});
      return {
        tagName: target?.tagName ?? null,
        text: target?.textContent?.trim() ?? null,
        buttonText: target?.closest("button")?.textContent?.trim() ?? null,
      };
    })()`,
  );
  status(
    `clicking ${sequenceName} preview at ${point.x.toFixed(1)},${point.y.toFixed(1)} hit=${JSON.stringify(hitTarget)}`,
  );
  await clickViewportPoint(point);
  await delay(250);
  const active = await evaluateJson(
    cdp,
    `Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent.trim() === "규칙 편집으로 돌아가기"
    )`,
  );
  status(`${sequenceName} active after click=${String(active)}`);
}

async function clickViewportPoint({ x, y }) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function readStepResultCounts(sequenceName) {
  return evaluateJson(
    cdp,
    `(() => {
      const headings = Array.from(document.querySelectorAll("strong")).filter(
        (node) => node.textContent.trim() === ${JSON.stringify(sequenceName)}
      );
      const heading = headings.find((node) => node.closest("section")?.querySelector("ol"));
      const list = heading?.closest("section")?.querySelector("ol");
      return Array.from(list?.querySelectorAll("li small") ?? []).map((node) => {
        const match = node.textContent.match(/(\\d+)개 결과/u);
        return match ? Number(match[1]) : 0;
      });
    })()`,
  );
}

async function waitForResultCount(expectedCount) {
  await waitForExpression(
    `(() => {
      const panel = document.querySelector('section[aria-label="결과"]');
      const text = panel?.querySelector("header strong")?.textContent ?? "";
      return /^결과 [0-9]+$/u.test(text.trim());
    })()`,
    "numeric result count",
  );
  const actualCount = await evaluateJson(
    cdp,
    `(() => {
      const panel = document.querySelector('section[aria-label="결과"]');
      const text = panel?.querySelector("header strong")?.textContent ?? "";
      const match = text.trim().match(/^결과 ([0-9]+)$/u);
      return match ? Number(match[1]) : null;
    })()`,
  );
  if (actualCount !== expectedCount) {
    await captureScreenshot("result-count-mismatch.png");
    throw new Error(
      `Result count differs: expected ${expectedCount}, got ${String(actualCount)}.`,
    );
  }
}

async function assertAllIncludeExclude(resultCount) {
  await clickExactButton("전체 제외", 'section[aria-label="결과"]');
  await waitForExpression(
    `(() => {
      const button = Array.from(document.querySelectorAll("footer button"))
        .find((candidate) => candidate.textContent.trim() === "연속 실행");
      return Boolean(button?.disabled);
    })()`,
    "apply disabled after excluding all results",
  );
  await clickExactButton("전체 포함", 'section[aria-label="결과"]');
  await waitForExpression(
    `(() => {
      const button = Array.from(document.querySelectorAll("footer button"))
        .find((candidate) => candidate.textContent.trim() === "연속 실행");
      return Boolean(button && !button.disabled);
    })()`,
    `apply enabled after including all ${resultCount} results`,
  );
}

async function clickExactButton(text, selector = "body") {
  const clicked = await evaluateJson(
    cdp,
    `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const button = Array.from(root?.querySelectorAll("button") ?? [])
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: "center" });
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`Could not click enabled button “${text}”.`);
}

async function waitForChapterBlocks(chapterId, expectedChapter, label) {
  const started = Date.now();
  let lastDifference = "chapter not read";
  while (Date.now() - started < operationTimeoutMs) {
    const actual = await evaluateJson(
      cdp,
      `window.mangaApi.openChapter(${JSON.stringify(chapterId)})`,
    );
    const actualBlocks = projectBlocks(actual);
    const expectedBlocks = projectBlocks(expectedChapter);
    if (isDeepStrictEqual(actualBlocks, expectedBlocks)) return actual;
    lastDifference = findFirstDifference(expectedBlocks, actualBlocks);
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastDifference}`);
}

function projectBlocks(chapter) {
  return chapter.pages.map((page) => ({
    id: page.id,
    blocks: page.blocks,
  }));
}

function findFirstDifference(expected, actual, path = "blocks") {
  if (Object.is(expected, actual)) return "";
  if (typeof expected !== typeof actual) {
    return `${path}: type ${typeof expected} != ${typeof actual}`;
  }
  if (!expected || !actual || typeof expected !== "object") {
    return `${path}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return `${path}: array shape differs`;
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (!isDeepStrictEqual(expectedKeys, actualKeys)) {
    return `${path}: keys ${JSON.stringify(expectedKeys)} != ${JSON.stringify(actualKeys)}`;
  }
  for (const key of expectedKeys) {
    const difference = findFirstDifference(
      expected[key],
      actual[key],
      `${path}.${key}`,
    );
    if (difference) return difference;
  }
  return `${path}: values differ`;
}

async function readApplyNotice() {
  return evaluateJson(
    cdp,
    `(() => {
      const panel = document.querySelector('[aria-label="일관 편집 규칙"]');
      return Array.from(panel?.querySelectorAll('[role="status"], [role="alert"]') ?? [])
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    })()`,
  );
}

async function captureScreenshot(fileName = "sequence-preview.png") {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  if (!screenshot.data) throw new Error("Electron returned no screenshot.");
  await writeFile(
    join(artifactRoot, fileName),
    Buffer.from(screenshot.data, "base64"),
  );
}

async function waitForExpression(expression, label) {
  const started = Date.now();
  while (Date.now() - started < operationTimeoutMs) {
    const result = await evaluateJson(cdp, `Boolean(${expression})`);
    if (result) return;
    if (electronProcess?.exitCode !== null) {
      throw new Error(
        `Electron exited with ${electronProcess?.exitCode} while waiting for ${label}.`,
      );
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function assertNoRuntimeErrors() {
  const uniqueExceptions = [...new Set(rendererExceptions.filter(Boolean))];
  const uniqueErrors = [...new Set(rendererErrors.filter(Boolean))];
  report.rendererDiagnostics = {
    exceptions: uniqueExceptions,
    errors: uniqueErrors,
  };
  if (uniqueExceptions.length || uniqueErrors.length) {
    throw new Error(
      `Renderer errors detected:\n${[...uniqueExceptions, ...uniqueErrors]
        .map((message) => `- ${message}`)
        .join("\n")}`,
    );
  }
}

async function assertMainLogHealthy() {
  const logPath = join(appRoot, "logs", "app.log");
  let contents;
  try {
    contents = await readFile(logPath, "utf8");
  } catch (error) {
    throw new Error(`The real app log was not created: ${logPath}`, {
      cause: error,
    });
  }
  const fatalLines = contents
    .split(/\r?\n/gu)
    .filter((line) =>
      /\[ERROR\]|Error occurred in handler|Maximum update depth|Unhandled rejection|Uncaught exception/iu.test(
        line,
      ),
    );
  report.mainLog = {
    path: logPath,
    fatalLines,
    lineCount: contents.split(/\r?\n/gu).length,
  };
  if (fatalLines.length) {
    throw new Error(
      `Main-process app log contains errors:\n${fatalLines.join("\n")}`,
    );
  }
}

function summarizeMatrix(fixture) {
  const byConditionFamily = countBy(
    fixture.caseInventory,
    (entry) => entry.conditionFamily,
  );
  const byActionFamily = countBy(
    fixture.caseInventory,
    (entry) => entry.actionFamily,
  );
  return {
    combinations: fixture.caseCount,
    schemeLimitReached: fixture.snapshot.schemes.length === 100,
    sequenceSizes: fixture.snapshot.sequences.map(
      (sequence) => sequence.steps.length,
    ),
    byConditionFamily,
    byActionFamily,
    cases: fixture.caseInventory,
  };
}

function countBy(values, readKey) {
  return Object.fromEntries(
    [
      ...values.reduce((counts, value) => {
        const key = readKey(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts;
      }, new Map()),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countBlocks(chapter) {
  return chapter.pages.reduce((total, page) => total + page.blocks.length, 0);
}

async function closeApp() {
  if (cdp) {
    try {
      await cdp.send("Browser.close");
    } catch (error) {
      // Process-tree cleanup below remains authoritative.
      void error;
    }
    cdp.close();
    cdp = null;
  }
  await stopProcess(electronProcess);
  electronProcess = null;
}

async function removeIsolatedAppRoot() {
  assertSafeAppRoot(appRoot);
  for (const linkPath of [
    join(appRoot, "node_modules"),
    join(appRoot, "tools"),
    join(appRoot, "out", "app-runtime"),
  ]) {
    try {
      const stat = await lstat(linkPath);
      if (stat.isSymbolicLink()) await unlink(linkPath);
    } catch (error) {
      // Missing optional links require no cleanup.
      void error;
    }
  }
  await rm(appRoot, { recursive: true, force: true, maxRetries: 3 });
}

function assertSafeAppRoot(path) {
  const expectedParent = join(sourceRoot, ".tmp", "conditional-batch-app-qa");
  const child = relative(expectedParent, path);
  if (!child || child.startsWith("..") || child.includes(`..${sep}`)) {
    throw new Error(`Refusing to remove unexpected QA app root: ${path}`);
  }
}

async function writeReport() {
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function status(message) {
  process.stdout.write(`[conditional-batch-app-qa] ${message}\n`);
}

function formatError(error) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const contract = require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-contract.cjs");
const inputs = require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-inputs.cjs");
const runner = require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-runner.cjs");
const runtime = require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-runtime.cjs");
const cli = require("../scripts/run-gemma-cleanup-audit.cjs");
const { ensureElectronExecutable } =
  require("../scripts/electron-executable.cjs") as {
    ensureElectronExecutable: (root: string) => string;
  };

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Gemma cleanup audit hardening", () => {
  it("executes the Electron entry main and fails invalid config without idling", () => {
    const root = join(__dirname, "..");
    const electron = ensureElectronExecutable(root);
    const runnerPath = join(
      root,
      "scripts",
      "library-full-pipeline-qa",
      "gemma-cleanup-audit-electron-runner.cjs",
    );
    const env = { ...process.env };
    delete env.MGT_GEMMA_CLEANUP_AUDIT_CONFIG;
    delete env.ELECTRON_RUN_AS_NODE;
    const isolatedUserData = join(
      makeTemporaryRoot(),
      "electron-invalid-config-user-data",
    );
    const result = spawnSync(
      electron,
      [`--user-data-dir=${isolatedUserData}`, runnerPath],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    expect(spawnError?.code).not.toBe("ETIMEDOUT");
    expect(spawnError).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).toContain(
      "Cleanup audit Electron config is missing.",
    );
  }, 20_000);

  it("freezes prepared bytes and rejects a tampered copy before requester", async () => {
    const sourcePage = makePage();
    const prepared = makePrepared(sourcePage);
    const originalPayload = prepared.page.original.dataUrl;
    sourcePage.original.dataUrl = "data:image/png;base64,bXV0YXRlZA==";
    expect(prepared.page.original.dataUrl).toBe(originalPayload);
    expect(Object.isFrozen(prepared.page.original)).toBe(true);

    const tampered = structuredClone(prepared);
    tampered.page.original.dataUrl = "data:image/png;base64,dGFtcGVyZWQ=";
    let requests = 0;
    await expect(
      runner.runAuditPage({
        prepared: tampered,
        requester: async () => {
          requests += 1;
          return cleanResponse("known-block");
        },
      }),
    ).rejects.toThrow("prepared source snapshot integrity mismatch");
    expect(requests).toBe(0);
  });

  it("rejects reversed image roles and preserves original then cleaned order", () => {
    const page = makePage();
    expect(() =>
      contract.buildExactTwoImageMessages({
        original: page.cleaned,
        cleaned: page.original,
        prompt: "fixture",
      }),
    ).toThrow("original image role mismatch");
    const prepared = makePrepared(page);
    expect(
      prepared.inputBinding.images.map(
        (image: { label: string; role: string }) =>
          `${image.label}:${image.role}`,
      ),
    ).toEqual(["Image1:original", "Image2:cleaned"]);
  });

  it("recomputes a maliciously resealed report summary", async () => {
    const fixture = await writeCompletedArtifact();
    const reportPath = join(fixture.outputRoot, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({
      promotionEligible: false,
      integrityScope: {
        kind: "unkeyed-sha256-local-structural-integrity",
        maliciousAuthenticity: false,
        keyedAttestation: false,
      },
    });
    report.summary.pageCount = 999;
    delete report.bindingSha256;
    delete report.sealed;
    writeFileSync(
      reportPath,
      `${JSON.stringify(contract.sealRecord(report), null, 2)}\n`,
      "utf8",
    );
    await expect(
      runner.validateExperimentArtifacts(fixture.outputRoot, {
        authoritativeInputs: fixture.authoritative,
      }),
    ).rejects.toThrow("report-summary-recomputed");
  });

  it("rejects a fully resealed alias-to-immutable mapping drift", async () => {
    const fixture = await writeCompletedArtifact();
    const reportPath = join(fixture.outputRoot, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const pageRecord = report.pages[0];
    const receiptPath = join(fixture.outputRoot, pageRecord.receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const pageDir = join(receiptPath, "..");
    const requestPath = join(pageDir, receipt.requestArtifact.path);
    const request = JSON.parse(readFileSync(requestPath, "utf8"));

    const input = structuredClone(request.inputBinding);
    input.page.blockAliasMap[0].blockId = "attacker-reordered-id";
    delete input.bindingSha256;
    delete input.sealed;
    request.inputBinding = contract.sealRecord(input);
    delete request.bindingSha256;
    delete request.sealed;
    writeFileSync(
      requestPath,
      `${JSON.stringify(contract.sealRecord(request), null, 2)}\n`,
      "utf8",
    );

    receipt.inputBindingSha256 = request.inputBinding.bindingSha256;
    receipt.requestArtifact.sha256 = contract.sha256(readFileSync(requestPath));
    delete receipt.bindingSha256;
    delete receipt.sealed;
    writeFileSync(
      receiptPath,
      `${JSON.stringify(contract.sealRecord(receipt), null, 2)}\n`,
      "utf8",
    );

    pageRecord.receiptSha256 = contract.sha256(readFileSync(receiptPath));
    delete report.bindingSha256;
    delete report.sealed;
    writeFileSync(
      reportPath,
      `${JSON.stringify(contract.sealRecord(report), null, 2)}\n`,
      "utf8",
    );

    await expect(
      runner.validateExperimentArtifacts(fixture.outputRoot, {
        authoritativeInputs: fixture.authoritative,
      }),
    ).rejects.toThrow("alias-bijection-binding");
  });

  it("rejects partial artifacts by default and permits explicit diagnostic validation", async () => {
    const outputRoot = join(makeTemporaryRoot(), "partial-artifact");
    const prepared = makePrepared(makePage());
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async () => {
        throw new Error("fixture transport failure");
      },
    });
    const authoritative = makeAuthoritative(prepared.page);
    await runner.writeExperimentArtifacts({
      outputRoot,
      sourceBinding: makeSourceBinding(authoritative, prepared.page),
      runtimeBinding: prepared.runtimeBinding,
      outcomes: [outcome],
    });
    await expect(
      runner.validateExperimentArtifacts(outputRoot, {
        authoritativeInputs: authoritative,
      }),
    ).rejects.toThrow("partial-report-disallowed");
    await expect(
      runner.validateExperimentArtifacts(outputRoot, {
        authoritativeInputs: authoritative,
        allowPartial: true,
      }),
    ).resolves.toMatchObject({ status: "partial" });
  });

  it("rejects junction escapes for output and cache using canonical paths", async () => {
    const root = makeTemporaryRoot();
    const library = join(root, "library");
    const runRoot = join(root, "artifacts", "frozen", "r1");
    const link = join(root, "artifacts", "junction-output");
    mkdirSync(library, { recursive: true });
    mkdirSync(runRoot, { recursive: true });
    mkdirSync(join(root, ".tmp"), { recursive: true });
    symlinkSync(library, link, "junction");
    await expect(
      inputs.assertShadowWriteTargets({
        root,
        runRoot,
        outputRoot: link,
        cacheDir: join(root, ".tmp", "safe-cache"),
      }),
    ).rejects.toThrow("source library");

    const cacheLink = join(root, ".tmp", "junction-cache");
    symlinkSync(runRoot, cacheLink, "junction");
    await expect(
      inputs.assertShadowWriteTargets({
        root,
        runRoot,
        outputRoot: join(root, "artifacts", "safe-output"),
        cacheDir: cacheLink,
      }),
    ).rejects.toThrow("frozen run");
  });

  it("rejects a pre-existing shadow temp-root junction before any runtime write", async () => {
    const root = makeTemporaryRoot();
    const redirectTarget = makeTemporaryRoot();
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const tempRoot = join(root, ".tmp", "gemma-cleanup-audit");
    symlinkSync(redirectTarget, tempRoot, "junction");
    const paths = runtime.buildAuditRunPaths(
      root,
      "11111111-1111-4111-8111-111111111111",
    );
    await expect(
      inputs.assertShadowRuntimeTargets({ root, ...paths }),
    ).rejects.toThrow(/symlink|junction|reparse/u);
    expect(readdirSync(redirectTarget)).toEqual([]);
  });

  it("rechecks output and cache after a safe precheck and rejects write-time swaps", async () => {
    const root = makeTemporaryRoot();
    const library = join(root, "library");
    const runRoot = join(root, "artifacts", "frozen", "r1");
    const outputRoot = join(root, "artifacts", "shadow-output");
    const cacheDir = join(root, ".tmp", "shadow-cache");
    mkdirSync(library, { recursive: true });
    mkdirSync(runRoot, { recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    const writeGuard = () =>
      inputs.assertShadowWriteTargets({
        root,
        runRoot,
        outputRoot,
        cacheDir,
      });
    await writeGuard();
    const prepared = makePrepared(makePage());
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async ({ passId }: { passId: AuditPassId }) =>
        cleanResponse(passId),
    });

    rmSync(outputRoot, { recursive: true });
    symlinkSync(library, outputRoot, "junction");
    await expect(
      runner.writeExperimentArtifacts({
        outputRoot,
        outputAlreadyCreated: true,
        sourceBinding: makeSourceBinding(
          makeAuthoritative(prepared.page),
          prepared.page,
        ),
        runtimeBinding: prepared.runtimeBinding,
        outcomes: [outcome],
        writeGuard,
      }),
    ).rejects.toThrow("source library");

    rmdirSync(outputRoot);
    mkdirSync(outputRoot);
    rmSync(cacheDir, { recursive: true });
    symlinkSync(runRoot, cacheDir, "junction");
    await expect(
      runner.runAuditPage({
        prepared,
        cacheDir,
        requester: async ({ passId }: { passId: AuditPassId }) =>
          cleanResponse(passId),
        writeGuard,
      }),
    ).rejects.toThrow("frozen run");
  });

  it("rejects conflicting server cache/parallel flags and strict CLI drift", () => {
    expect(() =>
      runtime.assertCacheDisabled([
        "--no-cache-prompt",
        "--cache-prompt",
        "-np",
        "1",
      ]),
    ).toThrow("prompt cache disabled");
    expect(() =>
      runtime.assertCacheDisabled([
        "--no-cache-prompt",
        "--no-cache-prompt",
        "-np",
        "1",
      ]),
    ).toThrow("prompt cache disabled");
    expect(() =>
      runtime.assertCacheDisabled([
        "--no-cache-prompt",
        "-np",
        "1",
        "--parallel",
        "1",
      ]),
    ).toThrow("prompt cache disabled");
    expect(() => cli.parseArguments(["run", "--np", "2"])).toThrow(
      "Unknown option",
    );
    expect(() =>
      cli.parseArguments(["run", "--cache", "a", "--cache", "b"]),
    ).toThrow("Duplicate");
    expect(() =>
      cli.resolveIndices(
        { index: "1,6" },
        { pages: [{ selectionIndex: 1 }, { selectionIndex: 6 }] },
      ),
    ).toThrow("--index accepts one integer");
    expect(
      cli.resolveIndices(
        { indices: "1,6" },
        { pages: [{ selectionIndex: 1 }, { selectionIndex: 6 }] },
      ),
    ).toEqual([1, 6]);
    expect(cli.parseArguments(["--help"])).toEqual({
      command: "help",
      options: {},
    });
  });

  it("seals actual launched paths once and detects later runtime mutation", async () => {
    const root = makeTemporaryRoot();
    const modelPath = writeFixture(root, "model.gguf", "model");
    const mmprojPath = writeFixture(root, "mmproj.gguf", "mmproj");
    const serverPath = writeFixture(root, "server.exe", "server");
    const templatePath = writeFixture(root, "template.jinja", "template");
    const expectedModel = makeRuntimeModel(
      contract.sha256(Buffer.from("model")),
      contract.sha256(Buffer.from("mmproj")),
      contract.sha256(Buffer.from("template")),
      Buffer.byteLength("template"),
    );
    let inspections = 0;
    const launchArguments = [
      "-m",
      modelPath,
      "--mmproj",
      mmprojPath,
      "-np",
      "1",
      "--no-cache-prompt",
    ];
    const built = await runtime.buildLiveRuntimeBinding({
      options: makeRuntimeOptions(expectedModel),
      expectedModel,
      launchedServer: {
        startedByScript: true,
        child: {
          spawnfile: serverPath,
          spawnargs: [serverPath, ...launchArguments],
        },
      },
      inspectModelLaunch: () => {
        inspections += 1;
        return { modelPath, mmprojPath, launchMode: "local" };
      },
      resolveRequestModelName: () => "fixture-gemma",
      verifyChatTemplate: () => templatePath,
      templateProvenance: {
        revision: "template-revision",
        expectedSha256: expectedModel.chatTemplate.expectedSha256,
        expectedBytes: expectedModel.chatTemplate.expectedBytes,
        source: "fixture",
      },
    });
    expect(inspections).toBe(1);
    expect(built.binding.serverRuntime.path).toBe(serverPath);
    for (const [assetPath, changed] of [
      [modelPath, "changed-model"],
      [mmprojPath, "changed-mmproj"],
      [serverPath, "changed-server"],
      [templatePath, "changed-template"],
    ]) {
      const original = readFileSync(assetPath);
      writeFileSync(assetPath, changed, "utf8");
      await expect(
        runtime.validateLiveRuntimeBindingFiles(built.binding, {
          model: expectedModel,
        }),
      ).rejects.toThrow("runtime file changed");
      writeFileSync(assetPath, original);
    }
    await expect(
      runtime.validateLiveRuntimeBindingFiles(built.binding, {
        model: expectedModel,
      }),
    ).resolves.toBeUndefined();
    for (const mutate of [
      (model: ReturnType<typeof makeRuntimeModel>) => {
        model.expectedSha256 = "a".repeat(64);
      },
      (model: ReturnType<typeof makeRuntimeModel>) => {
        model.mmproj.expectedSha256 = "b".repeat(64);
      },
      (model: ReturnType<typeof makeRuntimeModel>) => {
        model.chatTemplate.expectedSha256 = "c".repeat(64);
      },
    ]) {
      const wrong = structuredClone(expectedModel);
      mutate(wrong);
      await expect(
        runtime.validateLiveRuntimeBindingFiles(built.binding, {
          model: wrong,
        }),
      ).rejects.toThrow("frozen pins");
    }
  });

  it("guards temp paths before app setup and contains exactly one startServer call", () => {
    const source = readFileSync(
      join(
        __dirname,
        "..",
        "scripts",
        "library-full-pipeline-qa",
        "gemma-cleanup-audit-electron-runner.cjs",
      ),
      "utf8",
    );
    const firstGuard = source.indexOf("await runtimeWriteGuard();");
    const appSetup = source.indexOf("prepareElectron(runPaths.userData);");
    const appReady = source.indexOf("await app.whenReady();");
    expect(firstGuard).toBeGreaterThanOrEqual(0);
    expect(firstGuard).toBeLessThan(appSetup);
    expect(appSetup).toBeLessThan(appReady);
    expect(source.match(/simplePage\.startServer\(/gu) ?? []).toHaveLength(1);
  });

  it("uses unique run paths and an exclusive live lock", async () => {
    const root = makeTemporaryRoot();
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const firstPaths = runtime.buildAuditRunPaths(root, firstId);
    const secondPaths = runtime.buildAuditRunPaths(root, secondId);
    expect(firstPaths.userData).not.toBe(secondPaths.userData);
    expect(firstPaths.serverLog).not.toBe(secondPaths.serverLog);
    const firstGuard = () =>
      inputs.assertShadowRuntimeTargets({ root, ...firstPaths });
    const secondGuard = () =>
      inputs.assertShadowRuntimeTargets({ root, ...secondPaths });
    await firstGuard();
    const lock = await runtime.acquireAuditRunLock({
      root,
      runId: firstId,
      outputRoot: join(root, "artifacts", "one"),
      writeGuard: firstGuard,
    });
    await expect(
      runtime.acquireAuditRunLock({
        root,
        runId: secondId,
        outputRoot: join(root, "artifacts", "two"),
        writeGuard: secondGuard,
      }),
    ).rejects.toThrow("owns the live runtime lock");
    await lock.release();
    const next = await runtime.acquireAuditRunLock({
      root,
      runId: secondId,
      outputRoot: join(root, "artifacts", "two"),
      writeGuard: secondGuard,
    });
    await next.release();
  });

  it("fails before lock creation when a counted guard sees a write-time locks junction swap", async () => {
    const root = makeTemporaryRoot();
    const protectedTarget = join(root, "library", "protected-lock-target");
    mkdirSync(protectedTarget, { recursive: true });
    writeFileSync(
      join(protectedTarget, "sentinel.bin"),
      "immutable-protected-bytes",
      "utf8",
    );
    const before = snapshotProtected([protectedTarget]);
    const runId = "33333333-3333-4333-8333-333333333333";
    const paths = runtime.buildAuditRunPaths(root, runId);
    const locksRoot = join(paths.tempRoot, "locks");
    let guardCalls = 0;
    const countedGuard = async () => {
      guardCalls += 1;
      if (guardCalls === 3) {
        rmdirSync(locksRoot);
        symlinkSync(protectedTarget, locksRoot, "junction");
      }
      await inputs.assertShadowRuntimeTargets({ root, ...paths });
    };

    await expect(
      runtime.acquireAuditRunLock({
        root,
        runId,
        outputRoot: join(root, "artifacts", "never-written"),
        writeGuard: countedGuard,
      }),
    ).rejects.toThrow(/symlink|junction|reparse/u);
    expect(guardCalls).toBe(3);
    expect(existsSync(join(protectedTarget, "live.lock"))).toBe(false);
    expect(snapshotProtected([protectedTarget])).toEqual(before);
    rmdirSync(locksRoot);
  });

  it("leaves protected library and frozen-run bytes unchanged on a successful shadow fixture", async () => {
    const root = makeTemporaryRoot();
    const library = join(root, "library");
    const runRoot = join(root, "artifacts", "frozen", "r1");
    const outputRoot = join(root, "artifacts", "shadow-success");
    const cacheDir = join(root, ".tmp", "shadow-cache");
    mkdirSync(library, { recursive: true });
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(library, "source.txt"), "immutable-library", "utf8");
    writeFileSync(join(runRoot, "run.json"), "immutable-run", "utf8");
    const before = snapshotProtected([library, runRoot]);
    const writeGuard = () =>
      inputs.assertShadowWriteTargets({
        root,
        runRoot,
        outputRoot,
        cacheDir,
      });
    const prepared = makePrepared(makePage());
    const outcome = await runner.runAuditPage({
      prepared,
      cacheDir,
      requester: async ({ passId }: { passId: AuditPassId }) =>
        cleanResponse(passId),
      writeGuard,
    });
    const authoritative = makeAuthoritative(prepared.page);
    await runner.writeExperimentArtifacts({
      outputRoot,
      sourceBinding: makeSourceBinding(authoritative, prepared.page),
      runtimeBinding: prepared.runtimeBinding,
      outcomes: [outcome],
      writeGuard,
    });
    expect(snapshotProtected([library, runRoot])).toEqual(before);
  });
});

async function writeCompletedArtifact() {
  const outputRoot = join(makeTemporaryRoot(), "completed-artifact");
  const prepared = makePrepared(makePage());
  const outcome = await runner.runAuditPage({
    prepared,
    requester: async ({ passId }: { passId: AuditPassId }) =>
      cleanResponse(passId),
  });
  const authoritative = makeAuthoritative(prepared.page);
  await runner.writeExperimentArtifacts({
    outputRoot,
    sourceBinding: makeSourceBinding(authoritative, prepared.page),
    runtimeBinding: prepared.runtimeBinding,
    outcomes: [outcome],
  });
  return { outputRoot, prepared, authoritative };
}

function makePrepared(page = makePage()) {
  return runner.prepareAuditPage({
    page,
    modelName: "fixture-gemma",
    runtimeBinding: makeRuntimeBinding(),
  });
}

function makeRuntimeBinding() {
  const model = makeRuntimeModel(
    "5".repeat(64),
    "6".repeat(64),
    "8".repeat(64),
    8,
  );
  return contract.sealRecord({
    contractVersion: "fixture-runtime-v1",
    bindingKind: "live-local-gemma-runtime",
    executionAllowed: true,
    shadowOnly: true,
    productionMutationAllowed: false,
    modelName: "fixture-gemma",
    configuredModel: model,
    model: {
      path: "C:/fixture/model.gguf",
      bytes: 1,
      sha256: model.expectedSha256,
    },
    mmproj: {
      path: "C:/fixture/mmproj.gguf",
      bytes: 1,
      sha256: model.mmproj.expectedSha256,
    },
    serverRuntime: {
      path: "C:/fixture/server.exe",
      bytes: 1,
      sha256: "7".repeat(64),
    },
    chatTemplate: {
      path: "C:/fixture/template.jinja",
      bytes: model.chatTemplate.expectedBytes,
      sha256: model.chatTemplate.expectedSha256,
      revision: model.chatTemplate.revision,
    },
    launchArguments: [
      "-m",
      "C:/fixture/model.gguf",
      "--mmproj",
      "C:/fixture/mmproj.gguf",
      "-np",
      "1",
      "--no-cache-prompt",
    ],
  });
}

function makeRuntimeModel(
  modelSha: string,
  mmprojSha: string,
  templateSha: string,
  templateBytes: number,
) {
  return {
    provider: "gemma",
    source: "huggingface",
    repo: "fixture/repo",
    file: "fixture.gguf",
    revision: "fixture-model-revision",
    expectedSha256: modelSha,
    mmproj: {
      repo: "fixture/mmproj-repo",
      file: "fixture-mmproj.gguf",
      revision: "fixture-mmproj-revision",
      expectedSha256: mmprojSha,
    },
    chatTemplate: {
      revision: "template-revision",
      expectedSha256: templateSha,
      expectedBytes: templateBytes,
    },
  };
}

function makeRuntimeOptions(model: ReturnType<typeof makeRuntimeModel>) {
  return {
    modelProvider: "gemma",
    modelSource: "huggingface",
    modelRepo: model.repo,
    modelFile: model.file,
    mmprojRepo: model.mmproj.repo,
    mmprojFile: model.mmproj.file,
    useDraft: false,
    includeEnhancedVariant: false,
    reuseServer: false,
    cacheReuse: 0,
    cacheIdleSlots: 0,
    ctx: 8192,
    imageMinTokens: 1024,
    imageMaxTokens: 2048,
    gemmaVramMode: "balanced",
    llamaRuntimeProfile: "cpu",
  };
}

function makeAuthoritative(page: ReturnType<typeof makePage>) {
  return {
    manifestSha256: "1".repeat(64),
    runReportSha256: "2".repeat(64),
    runConfigSha256: "3".repeat(64),
    ledgerSha256: "4".repeat(64),
    manifest: {
      model: structuredClone(makeRuntimeBinding().configuredModel),
      evaluationRole: "development-only-not-holdout",
      holdoutEligible: false,
    },
    pages: [structuredClone(page)],
  };
}

function makeSourceBinding(
  authoritative: ReturnType<typeof makeAuthoritative>,
  page: ReturnType<typeof makePage>,
) {
  return contract.sealRecord({
    contractVersion: "fixture-source-v1",
    shadowOnly: true,
    frozenManifestSha256: authoritative.manifestSha256,
    runReportSha256: authoritative.runReportSha256,
    runConfigSha256: authoritative.runConfigSha256,
    manualLedgerSha256: authoritative.ledgerSha256,
    selectionIndices: [page.selectionIndex],
    pageIds: [page.pageId],
  });
}

function makePage() {
  const original = makeImage("original", Buffer.from("fixture-original"));
  const cleaned = makeImage("cleaned", Buffer.from("fixture-cleaned"));
  const blocks = [
    {
      blockId: "block-1",
      order: 0,
      sourceText: "原文",
      translatedText: "번역",
      bbox1000: { x: 1, y: 2, w: 3, h: 4 },
      bboxSpace: "normalized_1000",
      textRole: "ordinary",
    },
  ];
  return {
    selectionIndex: 14,
    expectedClass: "clean",
    pageId: "fixture-page",
    workId: "fixture-work",
    chapterId: "fixture-chapter",
    originalPath: "C:/fixture/original.png",
    cleanedPath: "C:/fixture/cleaned.png",
    fontInputPath: "C:/fixture/font-input.json",
    original,
    cleaned,
    fontInputSha256: "a".repeat(64),
    blocks,
    orderedBlockIdsSha256: contract.sha256Canonical(["block-1"]),
    sourceRunStatus: "completed",
    sourceRunStatusSemantics: "legacy-execution-only",
  };
}

function makeImage(role: "original" | "cleaned", bytes: Buffer) {
  const digest = contract.sha256(bytes);
  return {
    role,
    mime: "image/png",
    sourceBytes: bytes.length,
    sourceSha256: digest,
    payloadBytes: bytes.length,
    payloadSha256: digest,
    width: 100,
    height: 200,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  };
}

type AuditPassId = "known-block" | "unassigned-source";

function cleanResponse(passId: AuditPassId) {
  const result =
    passId === "known-block"
      ? {
          status: "clean",
          reason: "clean_no_known_block_source_glyphs",
          evidenceBlockAliases: [],
        }
      : {
          status: "clean",
          reason: "clean_no_unassigned_source_glyphs",
          japaneseGlyphSnippet: "",
          region: "none",
          category: "none",
        };
  return {
    rawResponseText: '{"transport":"fixture"}',
    outputText: JSON.stringify(result),
    finishReason: "stop",
  };
}

function writeFixture(root: string, name: string, contents: string) {
  const filePath = join(root, name);
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function snapshotProtected(roots: string[]) {
  const rows: Array<{
    root: string;
    path: string;
    kind: "directory" | "file";
    bytes: string;
    mtimeNs: string;
    sha256: string | null;
  }> = [];
  const visit = (root: string, current: string) => {
    const directoryStat = statSync(current, { bigint: true });
    rows.push({
      root,
      path: current.slice(root.length).replaceAll("\\", "/") || ".",
      kind: "directory",
      bytes: directoryStat.size.toString(),
      mtimeNs: directoryStat.mtimeNs.toString(),
      sha256: null,
    });
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(root, absolute);
      else {
        const fileStat = statSync(absolute, { bigint: true });
        rows.push({
          root,
          path: absolute.slice(root.length).replaceAll("\\", "/"),
          kind: "file",
          bytes: fileStat.size.toString(),
          mtimeNs: fileStat.mtimeNs.toString(),
          sha256: contract.sha256(readFileSync(absolute)),
        });
      }
    }
  };
  for (const root of roots) visit(root, root);
  return rows.sort((left, right) =>
    `${left.root}:${left.path}`.localeCompare(`${right.root}:${right.path}`),
  );
}

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "gemma-cleanup-hardening-"));
  temporaryRoots.push(root);
  return root;
}

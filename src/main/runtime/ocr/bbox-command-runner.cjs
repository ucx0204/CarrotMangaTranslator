// @ts-check
/** @typedef {import("../runtime-jsdoc-types").CommandSpec} CommandSpec */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {RuntimeOptions & { outputDir?: string | null }} OcrBboxOptions */
/** @typedef {{ timeoutMs?: number; onOutput?: ((line: string) => void) | null }} OcrCommandRunOptions */
/** @typedef {{ existsSync: (path: string) => boolean; mkdir: (path: string, options: { recursive: true }) => Promise<unknown>; readFile: (path: string, encoding: "utf8") => Promise<string>; path: typeof import("node:path"); extractJsonText: (text: unknown) => string; ensureOcrRuntime: (options: OcrBboxOptions) => Promise<OcrRuntimeLayout>; buildOcrBboxCommand: (options: OcrBboxOptions, provider: string, outputPath: string, runtime: OcrRuntimeLayout | null) => CommandSpec; formatCommandForLog: (command: CommandSpec) => string; emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void; resolveOcrDeviceLabel: (options: OcrBboxOptions) => string; resolveOcrEngineLabel: (options: OcrBboxOptions) => string; isHayaiOcrPipeline: (options: OcrBboxOptions) => boolean; isManagedOcrBboxProvider: (provider: unknown) => boolean; createOcrCommandProgressHandler: (options: OcrBboxOptions, context: Record<string, unknown>) => (line: string) => void; resolveOcrBboxTimeoutMs: (count: number) => number; createDetailedError: (message: string, details: Record<string, unknown>) => Error; truncateText: (value: unknown, limit: number) => string; runCommand: (command: CommandSpec, options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>; buildOcrRuntimeEnv: (options: OcrBboxOptions, runtime: OcrRuntimeLayout | null) => NodeJS.ProcessEnv; isPaddleOcrModelAssetLoadFailure: (error: unknown) => boolean; repairPaddleOcrModelAssetsCache: (options: OcrBboxOptions, runtime: OcrRuntimeLayout | null, error: unknown) => Promise<unknown> }} Dependencies */

/** @param {Dependencies} dependencies */
function createOcrCommandRunner(dependencies) {
  return {
    runOcrBboxCommand: runOcrBboxCommand.bind(null, dependencies),
    runOcrCommandWithModelRepair: runOcrCommandWithModelRepair.bind(
      null,
      dependencies,
    ),
  };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] @param {string} [provider] */
async function runOcrBboxCommand(
  dependencies,
  options = {},
  provider = "external-command",
) {
  const outputDir = options.outputDir || process.cwd();
  await dependencies.mkdir(outputDir, { recursive: true });
  const outputPath = dependencies.path.join(outputDir, "ocr-bbox-hints.json");
  const runtime = await resolveRuntime(dependencies, provider, options);
  const commandSpec = dependencies.buildOcrBboxCommand(
    options,
    provider,
    outputPath,
    runtime,
  );
  const command = dependencies.formatCommandForLog(commandSpec);
  emitCommandStarted(dependencies, options);
  const engine = dependencies.resolveOcrEngineLabel(options);
  const onOutput = dependencies.createOcrCommandProgressHandler(options, {
    engineLabel: engine,
    progressText: `${engine} 모델 다운로드/위치 분석 중`,
  });
  const output = await runOcrCommandWithModelRepair(
    dependencies,
    commandSpec,
    options,
    runtime,
    { timeoutMs: dependencies.resolveOcrBboxTimeoutMs(1), onOutput },
  );
  const rawText = await readCommandJson(
    dependencies,
    outputPath,
    output.stdout,
  );
  assertCommandJson(dependencies, rawText, {
    command,
    outputPath,
    ...output,
  });
  return buildCommandResult({
    command,
    outputPath,
    runtime,
    rawText,
    ...output,
  });
}

/** @param {Dependencies} dependencies @param {string} provider @param {OcrBboxOptions} options */
function resolveRuntime(dependencies, provider, options) {
  return dependencies.isManagedOcrBboxProvider(provider)
    ? dependencies.ensureOcrRuntime(options)
    : Promise.resolve(null);
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options */
function emitCommandStarted(dependencies, options) {
  const engine = dependencies.resolveOcrEngineLabel(options);
  dependencies.emitRuntimeProgress(
    options,
    "ocr_running",
    `${engine} 모델 다운로드/위치 분석 중`,
    `장치: ${dependencies.resolveOcrDeviceLabel(options)}`,
  );
}

/** @param {Dependencies} dependencies @param {string} outputPath @param {string} stdout */
async function readCommandJson(dependencies, outputPath, stdout) {
  return dependencies.existsSync(outputPath)
    ? await dependencies.readFile(outputPath, "utf8")
    : dependencies.extractJsonText(stdout);
}

/** @param {Dependencies} dependencies @param {string} rawText @param {{ command: string; outputPath: string; stdout: string; stderr: string }} context */
function assertCommandJson(dependencies, rawText, context) {
  if (rawText.trim()) {
    return;
  }
  throw dependencies.createDetailedError(
    "OCR bbox command did not produce JSON.",
    {
      command: context.command,
      outputPath: context.outputPath,
      stdoutPreview: dependencies.truncateText(context.stdout, 2000),
      stderrPreview: dependencies.truncateText(context.stderr, 2000),
    },
  );
}

/** @param {{ command: string; outputPath: string; runtime: OcrRuntimeLayout | null; stdout: string; stderr: string; rawText: string }} context */
function buildCommandResult(context) {
  return {
    command: context.command,
    outputPath: context.outputPath,
    runtimeDir: context.runtime?.runtimeDir || null,
    runtimeVariant: context.runtime?.runtimeVariant || null,
    packageDir: context.runtime?.packageDir || null,
    pythonPath: context.runtime?.pythonPath || null,
    runtimePrepared: Boolean(context.runtime?.prepared),
    runtimeDiagnostics: context.runtime?.diagnostics || [],
    stdout: context.stdout,
    stderr: context.stderr,
    payload: JSON.parse(context.rawText),
  };
}

/** @param {Dependencies} dependencies @param {CommandSpec} command @param {OcrBboxOptions} options @param {OcrRuntimeLayout | null} runtime @param {OcrCommandRunOptions} [runOptions] */
async function runOcrCommandWithModelRepair(
  dependencies,
  command,
  options = {},
  runtime = null,
  runOptions = {},
) {
  try {
    return await runCommandSpec(
      dependencies,
      command,
      options,
      runtime,
      runOptions,
    );
  } catch (error) {
    if (
      dependencies.isHayaiOcrPipeline(options) ||
      !dependencies.isPaddleOcrModelAssetLoadFailure(error)
    ) {
      throw error;
    }
    emitModelRepairProgress(dependencies, options);
    await dependencies.repairPaddleOcrModelAssetsCache(options, runtime, error);
    return await runCommandSpec(
      dependencies,
      command,
      options,
      runtime,
      runOptions,
    );
  }
}

/** @param {Dependencies} dependencies @param {CommandSpec} command @param {OcrBboxOptions} options @param {OcrRuntimeLayout | null} runtime @param {OcrCommandRunOptions} runOptions */
function runCommandSpec(dependencies, command, options, runtime, runOptions) {
  return dependencies.runCommand(command, {
    timeoutMs: runOptions.timeoutMs,
    env: dependencies.buildOcrRuntimeEnv(options, runtime),
    signal: options.abortSignal,
    onOutput: runOptions.onOutput,
  });
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options */
function emitModelRepairProgress(dependencies, options) {
  dependencies.emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 캐시 복구 중",
    "모델 캐시가 깨져 다시 다운로드합니다.",
    {
      progressMode: "log-only",
      installLogLine:
        "Paddle OCR 모델 로드 실패를 감지해 모델 캐시를 복구한 뒤 OCR을 다시 시도합니다.",
    },
  );
}

module.exports = { createOcrCommandRunner };

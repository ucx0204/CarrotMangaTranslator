// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { ocrBboxHints?: unknown; ocrBboxHintsPath?: string | null; ocrBboxResult?: unknown; skipOcrBboxHints?: boolean | null }} OcrBboxOptions */
/** @typedef {{ hints: unknown[]; diagnostics: unknown[]; noTextDetected: boolean; textEvidenceCount: number }} OcrBboxResult */
/** @typedef {{ result: OcrBboxResult | null; diagnostics: unknown[] }} ConfiguredResult */
/** @typedef {{ command?: unknown; outputPath?: unknown; runtimeDir?: unknown; runtimeVariant?: unknown; packageDir?: unknown; pythonPath?: unknown; runtimePrepared?: unknown; runtimeDiagnostics?: unknown; stdout?: unknown; stderr?: unknown; payload?: unknown }} CommandResult */
/** @typedef {{ readFile: (path: string, encoding: "utf8") => Promise<string>; runtimeOverrideEnv: (name: string, options?: RuntimeOptions) => unknown; normalizeOcrBboxHintPayload: (payload: unknown, options?: OcrBboxOptions) => unknown[]; buildOcrBboxResult: (hints?: unknown[], diagnostics?: unknown[], options?: Record<string, unknown>) => OcrBboxResult; normalizeOcrBboxResultPayload: (value: unknown, options?: OcrBboxOptions) => { hints: unknown[]; diagnostics: unknown[]; noTextDetected?: boolean; textEvidenceCount?: number }; buildOcrBboxDiagnostic: (provider: string, error: unknown, extra?: Record<string, unknown>) => Record<string, unknown>; resolveOcrBboxProvider: (options?: OcrBboxOptions) => string; isOcrGpuRequested: (options?: OcrBboxOptions) => boolean; resolveEffectiveOcrDevice: (options?: OcrBboxOptions) => string; buildPaddleOcrGpuFailureMessage: (error: unknown, options?: OcrBboxOptions) => string; createOcrRuntimeError: (message: string, details: Record<string, unknown>, cause?: unknown) => Error; emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void; truncateText: (value: unknown, limit: number) => string; resolveOcrDeviceLabel: (options?: OcrBboxOptions) => string; runOcrBboxCommand: (options?: OcrBboxOptions, provider?: string) => Promise<CommandResult> }} Dependencies */

/** @param {Dependencies} dependencies */
function createOcrSinglePipeline(dependencies) {
  return {
    collectOcrBboxHints: collectOcrBboxHints.bind(null, dependencies),
  };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] @returns {Promise<OcrBboxResult>} */
async function collectOcrBboxHints(dependencies, options = {}) {
  const configured = await readConfiguredOcrResult(dependencies, options);
  if (configured.result) {
    return configured.result;
  }
  const provider = dependencies.resolveOcrBboxProvider(options);
  if (provider === "none" || provider === "json-file") {
    return dependencies.buildOcrBboxResult([], configured.diagnostics, {
      noTextDetected: false,
    });
  }
  return await runProviderWithFailureHandling(
    dependencies,
    options,
    provider,
    configured.diagnostics,
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @returns {Promise<ConfiguredResult>} */
async function readConfiguredOcrResult(dependencies, options) {
  if (options.skipOcrBboxHints) {
    return {
      result: dependencies.buildOcrBboxResult(
        [],
        [{ provider: "disabled", reason: "skipOcrBboxHints" }],
        { noTextDetected: false },
      ),
      diagnostics: [],
    };
  }
  if (hasOwn(options, "ocrBboxResult")) {
    return {
      result: buildConfiguredResult(
        dependencies,
        options.ocrBboxResult,
        options,
      ),
      diagnostics: [],
    };
  }
  if (hasOwn(options, "ocrBboxHints")) {
    return {
      result: buildInlineResult(dependencies, options),
      diagnostics: [],
    };
  }
  return await readJsonFileResult(dependencies, options);
}

/** @param {Dependencies} dependencies @param {unknown} value @param {OcrBboxOptions} options */
function buildConfiguredResult(dependencies, value, options) {
  const result = dependencies.normalizeOcrBboxResultPayload(value, options);
  return dependencies.buildOcrBboxResult(result.hints, result.diagnostics, {
    noTextDetected: result.noTextDetected,
    textEvidenceCount: result.textEvidenceCount,
  });
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options */
function buildInlineResult(dependencies, options) {
  const hints = dependencies.normalizeOcrBboxHintPayload(
    options.ocrBboxHints,
    options,
  );
  return dependencies.buildOcrBboxResult(hints, [
    { provider: "inline", hintCount: hints.length },
  ]);
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @returns {Promise<ConfiguredResult>} */
async function readJsonFileResult(dependencies, options) {
  const path = resolveHintsPath(dependencies, options);
  if (!path) {
    return { result: null, diagnostics: [] };
  }
  try {
    const text = await dependencies.readFile(path, "utf8");
    const hints = dependencies.normalizeOcrBboxHintPayload(
      JSON.parse(text),
      options,
    );
    return {
      result: dependencies.buildOcrBboxResult(hints, [
        { provider: "json-file", path },
      ]),
      diagnostics: [],
    };
  } catch (error) {
    return {
      result: null,
      diagnostics: [
        dependencies.buildOcrBboxDiagnostic("json-file", error, { path }),
      ],
    };
  }
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options */
function resolveHintsPath(dependencies, options) {
  return String(
    options.ocrBboxHintsPath ??
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH",
        options,
      ) ??
      "",
  ).trim();
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {string} provider @param {unknown[]} diagnostics */
async function runProviderWithFailureHandling(
  dependencies,
  options,
  provider,
  diagnostics,
) {
  try {
    return await runProviderOcrBbox(dependencies, options, provider);
  } catch (error) {
    if (!isGpuExecutionFailure(dependencies, provider, options)) {
      throw error;
    }
    diagnostics.push(dependencies.buildOcrBboxDiagnostic(provider, error));
    throwGpuExecutionFailure(dependencies, options, diagnostics, error);
  }
}

/** @param {Dependencies} dependencies @param {string} provider @param {OcrBboxOptions} options */
function isGpuExecutionFailure(dependencies, provider, options) {
  return (
    provider === "paddleocr" &&
    dependencies.isOcrGpuRequested(options) &&
    dependencies.resolveEffectiveOcrDevice(options) !== "cpu"
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {unknown[]} diagnostics @param {unknown} error @returns {never} */
function throwGpuExecutionFailure(dependencies, options, diagnostics, error) {
  const message = dependencies.buildPaddleOcrGpuFailureMessage(error, options);
  emitGpuFailure(
    dependencies,
    options,
    "Paddle OCR GPU 실행 실패 — 작업을 중지합니다",
    message,
  );
  throw dependencies.createOcrRuntimeError(message, { diagnostics }, error);
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {string} title @param {string} detail */
function emitGpuFailure(dependencies, options, title, detail) {
  dependencies.emitRuntimeProgress(options, "ocr_running", title, detail);
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {string} provider */
async function runProviderOcrBbox(dependencies, options, provider) {
  dependencies.emitRuntimeProgress(
    options,
    "ocr_preparing",
    "Paddle OCR 준비 중",
    `장치: ${dependencies.resolveOcrDeviceLabel(options)}`,
  );
  const commandResult = await dependencies.runOcrBboxCommand(options, provider);
  const hints = dependencies.normalizeOcrBboxHintPayload(
    commandResult.payload,
    options,
  );
  const result = buildProviderResult(
    dependencies,
    provider,
    commandResult,
    hints,
  );
  emitProviderResult(dependencies, options, result, hints.length);
  return result;
}

/** @param {Dependencies} dependencies @param {string} provider @param {CommandResult} commandResult @param {unknown[]} hints */
function buildProviderResult(dependencies, provider, commandResult, hints) {
  return dependencies.buildOcrBboxResult(hints, [
    {
      provider,
      command: commandResult.command,
      outputPath: commandResult.outputPath,
      runtimeDir: commandResult.runtimeDir || null,
      runtimeVariant: commandResult.runtimeVariant || null,
      packageDir: commandResult.packageDir || null,
      pythonPath: commandResult.pythonPath || null,
      runtimePrepared: commandResult.runtimePrepared || false,
      hintCount: hints.length,
      stdoutPreview: dependencies.truncateText(
        String(commandResult.stdout ?? "").trim(),
        1200,
      ),
      stderrPreview: dependencies.truncateText(
        String(commandResult.stderr ?? "").trim(),
        1200,
      ),
      runtimeDiagnostics: commandResult.runtimeDiagnostics || [],
    },
  ]);
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {OcrBboxResult} result @param {number} hintCount */
function emitProviderResult(dependencies, options, result, hintCount) {
  const device = dependencies.resolveOcrDeviceLabel(options);
  dependencies.emitRuntimeProgress(
    options,
    "ocr_running",
    result.noTextDetected
      ? "Paddle OCR 텍스트 없음"
      : `Paddle OCR 후보 ${hintCount}개 감지`,
    result.noTextDetected
      ? `장치: ${device}, 텍스트 근거 없음`
      : `장치: ${device}`,
  );
}

/** @param {object} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

module.exports = { createOcrSinglePipeline };

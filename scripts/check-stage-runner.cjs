const { spawn } = require("node:child_process");
const { createWriteStream, mkdirSync, readFileSync } = require("node:fs");
const { availableParallelism, freemem } = require("node:os");
const { join, relative } = require("node:path");

const root = join(__dirname, "..");
const defaultLogDirectory = join(root, ".tmp", "check-logs");
const GIBIBYTE = 1024 ** 3;

/**
 * @typedef {"parallel" | "exclusive"} CheckExecutionClass
 * @typedef {{
 *   id: string;
 *   command: string;
 *   args: string[];
 *   dependsOn: string[];
 *   executionClass: CheckExecutionClass;
 * }} CheckStage
 * @typedef {{
 *   id: string;
 *   command: string;
 *   dependsOn: string[];
 *   executionClass: CheckExecutionClass;
 *   queuedMs: number;
 *   durationMs: number;
 *   startedAt: string;
 *   completedAt: string;
 *   status: "passed" | "failed";
 *   exitCode: number;
 *   logPath: string;
 *   logBytes: number;
 *   cacheHit?: boolean;
 *   metadata?: Record<string, unknown>;
 * }} CheckStageResult
 */

/** @param {number} milliseconds */
function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

/**
 * @param {{ availableCpuCount?: number; freeMemory?: number }} [system]
 */
function resolveCheckParallelism(system = {}) {
  const cpuCount = Math.max(
    1,
    Math.floor(system.availableCpuCount ?? availableParallelism()),
  );
  const freeMemoryBytes = Math.max(0, system.freeMemory ?? freemem());
  return Math.max(
    1,
    Math.min(
      4,
      Math.max(1, Math.floor(cpuCount / 4)),
      Math.max(1, Math.floor(freeMemoryBytes / (2 * GIBIBYTE))),
    ),
  );
}

/** @param {CheckStage[]} stages */
function validateStages(stages) {
  const byId = new Map();
  for (const stage of stages) {
    if (!/^[a-z0-9-]+$/u.test(stage.id)) {
      throw new Error(`Invalid check stage id: ${stage.id}`);
    }
    if (byId.has(stage.id)) {
      throw new Error(`Duplicate check stage id: ${stage.id}`);
    }
    if (
      stage.executionClass !== "parallel" &&
      stage.executionClass !== "exclusive"
    ) {
      throw new Error(`Invalid execution class for ${stage.id}`);
    }
    byId.set(stage.id, stage);
  }
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`${stage.id} depends on missing stage ${dependency}`);
      }
    }
  }
  assertAcyclicStages(stages, byId);
  return stages;
}

/** @param {CheckStage[]} stages @param {Map<string, CheckStage>} byId */
function assertAcyclicStages(stages, byId) {
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {CheckStage} stage */
  function visit(stage) {
    if (visiting.has(stage.id)) {
      throw new Error(`Check stage dependency cycle includes ${stage.id}`);
    }
    if (visited.has(stage.id)) return;
    visiting.add(stage.id);
    for (const dependency of stage.dependsOn) {
      visit(/** @type {CheckStage} */ (byId.get(dependency)));
    }
    visiting.delete(stage.id);
    visited.add(stage.id);
  }
  for (const stage of stages) visit(stage);
}

/**
 * @param {CheckStage} stage
 * @param {{ env: NodeJS.ProcessEnv; logDirectory: string; queuedMs: number }} options
 * @returns {Promise<CheckStageResult>}
 */
function runStage(stage, options) {
  mkdirSync(options.logDirectory, { recursive: true });
  const logPath = join(options.logDirectory, `${stage.id}.log`);
  const stream = createWriteStream(logPath, { encoding: "utf8", flags: "w" });
  const started = monotonicMilliseconds();
  const startedAt = new Date().toISOString();
  console.log(`[check] start ${stage.id}`);
  return new Promise((resolve) => {
    let logBytes = 0;
    const child = spawn(stage.command, stage.args, {
      cwd: root,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    /** @param {Buffer | string} chunk */
    const writeChunk = (chunk) => {
      logBytes += Buffer.byteLength(chunk);
      stream.write(chunk);
    };
    child.stdout?.on("data", writeChunk);
    child.stderr?.on("data", writeChunk);
    child.on("error", (error) => {
      writeChunk(`${error.stack ?? error.message}\n`);
    });
    child.on("close", (code, signal) => {
      if (signal) writeChunk(`[check] terminated by ${signal}\n`);
      stream.end(() => {
        resolve(
          createStageResult({
            stage,
            logPath,
            logBytes,
            queuedMs: options.queuedMs,
            started,
            startedAt,
            exitCode: code ?? 1,
          }),
        );
      });
    });
  });
}

/**
 * @param {{
 *   stage: CheckStage;
 *   logPath: string;
 *   logBytes: number;
 *   queuedMs: number;
 *   started: number;
 *   startedAt: string;
 *   exitCode: number;
 * }} options
 */
function createStageResult(options) {
  const metadata = readStageMetadata(options.logPath, options.stage.id);
  /** @type {"passed" | "failed"} */
  const status = options.exitCode === 0 ? "passed" : "failed";
  return {
    id: options.stage.id,
    command: [options.stage.command, ...options.stage.args].join(" "),
    dependsOn: [...options.stage.dependsOn],
    executionClass: options.stage.executionClass,
    queuedMs: Math.round(options.queuedMs),
    durationMs: Math.round(monotonicMilliseconds() - options.started),
    startedAt: options.startedAt,
    completedAt: new Date().toISOString(),
    status,
    exitCode: options.exitCode,
    logPath: relative(root, options.logPath).replaceAll("\\", "/"),
    logBytes: options.logBytes,
    ...(typeof metadata.cacheHit === "boolean"
      ? { cacheHit: metadata.cacheHit }
      : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** @param {string} logPath @param {string} [expectedStageId] */
function readStageMetadata(logPath, expectedStageId) {
  try {
    const metadata = {};
    for (const match of readFileSync(logPath, "utf8").matchAll(
      /^\[check-metadata\] (\{.*\})$/gmu,
    )) {
      const value = JSON.parse(match[1]);
      if (
        typeof value === "object" &&
        value !== null &&
        (!expectedStageId || value.stage === expectedStageId)
      ) {
        Object.assign(metadata, value);
      }
    }
    return /** @type {Record<string, unknown>} */ (metadata);
  } catch (_error) {
    return {};
  }
}

/**
 * @param {CheckStage[]} inputStages
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   maxParallel?: number;
 *   logDirectory?: string;
 *   run?: typeof runStage;
 * }} [options]
 * @returns {Promise<CheckStageResult[]>}
 */
function runStageGraph(inputStages, options = {}) {
  const stages = validateStages(inputStages);
  const context = createGraphContext(stages, options);
  return new Promise((resolve, reject) => {
    context.resolve = resolve;
    context.reject = reject;
    pumpGraph(context);
  });
}

/** @param {CheckStage[]} stages @param {Parameters<typeof runStageGraph>[1]} options */
function createGraphContext(stages, options = {}) {
  return {
    stages,
    env: options.env ?? process.env,
    maxParallel: Math.max(
      1,
      Math.floor(options.maxParallel ?? resolveCheckParallelism()),
    ),
    execute: options.run ?? runStage,
    logDirectory: options.logDirectory ?? defaultLogDirectory,
    pipelineStarted: monotonicMilliseconds(),
    pending: new Map(stages.map((stage) => [stage.id, stage])),
    running: new Map(),
    completed: new Map(),
    readySince: new Map(),
    failureSeen: false,
    resolve: /** @type {(results: CheckStageResult[]) => void} */ (() => {}),
    reject: /** @type {(error: unknown) => void} */ (() => {}),
  };
}

/** @param {ReturnType<typeof createGraphContext>} context */
function pumpGraph(context) {
  try {
    if (!context.failureSeen) scheduleReadyStages(context);
    if (context.running.size > 0) return;
    if (context.failureSeen || context.pending.size === 0) {
      context.resolve(
        context.stages.flatMap((stage) => {
          const result = context.completed.get(stage.id);
          return result ? [result] : [];
        }),
      );
      return;
    }
    throw new Error(
      `Check graph stalled with pending stages: ${[...context.pending.keys()].join(", ")}`,
    );
  } catch (error) {
    context.reject(error);
  }
}

/** @param {ReturnType<typeof createGraphContext>} context */
function scheduleReadyStages(context) {
  const readyAt = monotonicMilliseconds();
  for (const stage of context.stages) {
    if (
      context.pending.has(stage.id) &&
      dependenciesPassed(stage, context) &&
      !context.readySince.has(stage.id)
    ) {
      context.readySince.set(stage.id, readyAt);
    }
  }
  const exclusiveRunning = [...context.running.keys()].some(
    (id) =>
      context.stages.find((candidate) => candidate.id === id)
        ?.executionClass === "exclusive",
  );
  if (exclusiveRunning) return;
  for (const stage of context.stages) {
    if (!context.pending.has(stage.id) || !context.readySince.has(stage.id)) {
      continue;
    }
    if (stage.executionClass === "exclusive") {
      if (context.running.size > 0) return;
      startStage(context, stage);
      return;
    }
    if (context.running.size >= context.maxParallel) return;
    startStage(context, stage);
  }
}

/** @param {CheckStage} stage @param {ReturnType<typeof createGraphContext>} context */
function dependenciesPassed(stage, context) {
  return stage.dependsOn.every(
    (id) => context.completed.get(id)?.status === "passed",
  );
}

/** @param {ReturnType<typeof createGraphContext>} context @param {CheckStage} stage */
function startStage(context, stage) {
  context.pending.delete(stage.id);
  const queuedAt = context.readySince.get(stage.id) ?? context.pipelineStarted;
  const promise = context
    .execute(stage, {
      env: context.env,
      logDirectory: context.logDirectory,
      queuedMs: monotonicMilliseconds() - queuedAt,
    })
    .then((result) => finishStage(context, result))
    .catch((error) => recordRunnerFailure(context, stage, queuedAt, error))
    .finally(() => {
      context.running.delete(stage.id);
      pumpGraph(context);
    });
  context.running.set(stage.id, promise);
}

/** @param {ReturnType<typeof createGraphContext>} context @param {CheckStageResult} result */
function finishStage(context, result) {
  context.completed.set(result.id, result);
  if (result.status === "failed") context.failureSeen = true;
  console.log(
    `[check] ${result.id} ${result.status} in ${formatDuration(result.durationMs)}`,
  );
}

/**
 * @param {ReturnType<typeof createGraphContext>} context
 * @param {CheckStage} stage
 * @param {number} queuedAt
 * @param {unknown} error
 */
function recordRunnerFailure(context, stage, queuedAt, error) {
  context.failureSeen = true;
  const now = new Date().toISOString();
  context.completed.set(stage.id, {
    id: stage.id,
    command: [stage.command, ...stage.args].join(" "),
    dependsOn: [...stage.dependsOn],
    executionClass: stage.executionClass,
    queuedMs: Math.round(monotonicMilliseconds() - queuedAt),
    durationMs: 0,
    startedAt: now,
    completedAt: now,
    status: "failed",
    exitCode: 1,
    logPath: "",
    logBytes: 0,
    metadata: { runnerError: String(error) },
  });
}

/** @param {CheckStage[]} stages @param {CheckStageResult[]} results */
function calculateCriticalPathMs(stages, results) {
  const resultById = new Map(results.map((result) => [result.id, result]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  /** @type {Map<string, number>} */
  const totals = new Map();
  /** @param {string} id */
  function visit(id) {
    if (totals.has(id)) return /** @type {number} */ (totals.get(id));
    const stage = stageById.get(id);
    const result = resultById.get(id);
    if (!stage || !result) return 0;
    const dependencyTotal = Math.max(
      0,
      ...stage.dependsOn.map((dependency) => visit(dependency)),
    );
    const total = dependencyTotal + result.durationMs;
    totals.set(id, total);
    return total;
  }
  return Math.max(0, ...stages.map((stage) => visit(stage.id)));
}

module.exports = {
  calculateCriticalPathMs,
  monotonicMilliseconds,
  readStageMetadata,
  resolveCheckParallelism,
  runStage,
  runStageGraph,
  validateStages,
};

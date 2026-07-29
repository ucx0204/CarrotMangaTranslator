import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildFluxWorkerEnv } from "../src/main/inpainting/fluxWorkerEnv";
import { buildFluxPythonLaunchSpec } from "../src/main/inpainting/fluxAssets/pythonRuntimeLaunchSpec";
import {
  buildFluxPythonHuggingFaceEnv,
  ensureFluxPythonModelCache,
} from "../src/main/inpainting/fluxAssets/pythonRuntimePackages";

const tempDirs: string[] = [];

describe("Flux Python Hugging Face environment", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("uses the stable HTTP download path instead of hf-xet by default", () => {
    const modelDir = join("data", "models", "flux");

    expect(
      buildFluxPythonHuggingFaceEnv({ MGT_TEST_ENV: "kept" }, modelDir),
    ).toMatchObject({
      MGT_TEST_ENV: "kept",
      HF_HOME: modelDir,
      HF_HUB_CACHE: join(modelDir, "hub"),
      HUGGINGFACE_HUB_CACHE: join(modelDir, "hub"),
      HF_HUB_ETAG_TIMEOUT: "30",
      HF_HUB_DOWNLOAD_TIMEOUT: "300",
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      HF_HUB_DISABLE_XET: "1",
    });
  });

  it("keeps an explicit hf-xet override for diagnostics", () => {
    expect(
      buildFluxPythonHuggingFaceEnv(
        {
          HF_HUB_DISABLE_XET: "0",
          HF_HUB_ETAG_TIMEOUT: "12",
          HF_HUB_DOWNLOAD_TIMEOUT: "45",
        },
        join("data", "models", "flux"),
      ),
    ).toMatchObject({
      HF_HUB_DISABLE_XET: "0",
      HF_HUB_ETAG_TIMEOUT: "12",
      HF_HUB_DOWNLOAD_TIMEOUT: "45",
    });
  });

  it("passes the stable download environment to snapshot_download", async () => {
    const modelDir = await createTempModelDir();
    const probePath = join(modelDir, "env-probe.cjs");
    const outputPath = join(modelDir, "env-probe.json");
    await writeFile(
      probePath,
      [
        'const { writeFileSync } = require("node:fs");',
        "const keys = [",
        '  "HF_HOME",',
        '  "HF_HUB_CACHE",',
        '  "HF_HUB_DISABLE_XET",',
        '  "HF_HUB_ETAG_TIMEOUT",',
        '  "HF_HUB_DOWNLOAD_TIMEOUT",',
        "];",
        "writeFileSync(",
        "  process.argv[2],",
        "  JSON.stringify({",
        "    args: process.argv.slice(3),",
        "    env: Object.fromEntries(keys.map((key) => [key, process.env[key]])),",
        "  }),",
        ");",
      ].join("\n"),
      "utf8",
    );

    await ensureFluxPythonModelCache({
      pythonRuntime: createPythonRuntime({
        command: process.execPath,
        executable: process.execPath,
        args: [probePath, outputPath],
      }),
      modelDir,
      modelId: "example/flux-model",
    });

    const probe = JSON.parse(await readFile(outputPath, "utf8")) as {
      args: string[];
      env: NodeJS.ProcessEnv;
    };
    expect(probe.args[0]).toBe("-c");
    expect(probe.args).toContain("example/flux-model");
    expect(probe.env).toMatchObject({
      HF_HOME: modelDir,
      HF_HUB_CACHE: join(modelDir, "hub"),
      HF_HUB_DISABLE_XET: "1",
      HF_HUB_ETAG_TIMEOUT: "30",
      HF_HUB_DOWNLOAD_TIMEOUT: "300",
    });
  });

  it("keeps the same environment on the final Python worker process", async () => {
    const modelDir = await createTempModelDir();
    const modelId = "example/flux-model";
    const downloadGuardPath = join(modelDir, "fail-on-download.cjs");
    const previousModelId = process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID;
    await writeFile(downloadGuardPath, "process.exitCode = 99;\n", "utf8");
    await writeFile(
      join(modelDir, ".mgt-flux-diffusers-model.json"),
      JSON.stringify({ modelId, ignorePatterns: [] }),
      "utf8",
    );
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID = modelId;

    try {
      const launch = await buildFluxPythonLaunchSpec({
        backend: "python-cpu",
        modelDir,
        pythonRuntime: createPythonRuntime({
          command: process.execPath,
          executable: process.execPath,
          args: [downloadGuardPath],
        }),
        workerPath: join(modelDir, "flux-worker.py"),
      });

      expect(buildFluxWorkerEnv(launch)).toMatchObject({
        HF_HOME: modelDir,
        HF_HUB_CACHE: join(modelDir, "hub"),
        HF_HUB_DISABLE_XET: "1",
        HF_HUB_ETAG_TIMEOUT: "30",
        HF_HUB_DOWNLOAD_TIMEOUT: "300",
      });
    } finally {
      restoreEnv("MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID", previousModelId);
    }
  });
});

async function createTempModelDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "manga-flux-hf-env-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createPythonRuntime(
  overrides: Partial<{
    command: string;
    executable: string;
    args: string[];
  }> = {},
) {
  return {
    mode: "target" as const,
    command: "python",
    executable: "python",
    args: [],
    packageDir: null,
    ...overrides,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

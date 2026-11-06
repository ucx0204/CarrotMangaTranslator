import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cliRuntimePlan } from "../src/main/runtimeSupport/cliRuntimePlan";
import {
  CliNotInstalledError,
  ensureManagedCli as installManagedCli,
  type CliInstallOptions,
  findManagedCli,
} from "../src/main/runtimeSupport/managedCliRuntime";
import {
  ensureCodexAppServerBinary,
  resolveCodexAppServerBinary,
} from "../src/main/codexAppServerBinary";
import {
  claudeBinary,
  ensureClaudeBinary,
} from "../src/main/claude/claudeRuntime";
import {
  authenticateClaude,
  readClaudeAccount,
} from "../src/main/claude/claudeAccount";
import type { AppPaths } from "../src/main/appPaths";

const download = vi.fn();
const ensureManagedCli = (
  dataRoot: string,
  provider: "claude" | "codex" | "grok",
  options?: CliInstallOptions,
) => installManagedCli(dataRoot, provider, options, { download });
let root: string;
let archives: Record<string, string>;
const paths = () =>
  ({
    dataRoot: root,
    resourcesDir: join(root, "resources"),
    isPackaged: true,
  }) as AppPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mgt-cli-test-"));
  archives = {};
  for (const provider of ["claude", "codex", "grok"] as const) {
    const plan = cliRuntimePlan(provider);
    const source = join(root, "source-" + provider, "package");
    await mkdir(dirname(join(source, plan.executable)), { recursive: true });
    await writeFile(
      join(source, plan.compressedExecutable ?? plan.executable),
      plan.compressedExecutable
        ? brotliCompressSync("official executable fixture")
        : "official executable fixture",
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ version: plan.version }),
    );
    await writeFile(join(source, "LICENSE.md"), "official license fixture");
    archives[provider] = join(root, provider + ".tgz");
    await tar.c(
      { gzip: true, cwd: dirname(source), file: archives[provider] },
      ["package"],
    );
  }
  download
    .mockReset()
    .mockImplementation(
      async (options: { label: string }) =>
        archives[options.label.toLowerCase().replace(" build", "")],
    );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(["claude", "codex", "grok"] as const)(
  "installs %s atomically with licenses, pins the download, and reuses it offline",
  async (provider) => {
    expect(findManagedCli(root, provider)).toBeNull();
    const executable = await ensureManagedCli(root, provider);
    expect(await readFile(executable, "utf8")).toBe(
      "official executable fixture",
    );
    expect(findManagedCli(root, provider)).toBe(executable);
    expect(await ensureManagedCli(root, provider)).toBe(executable);
    expect(download).toHaveBeenCalledOnce();
    const plan = cliRuntimePlan(provider);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: plan.url,
        minimumBytes: plan.bytes,
        maximumBytes: plan.bytes,
        expectedSha256: plan.sha256,
      }),
    );
    const directory = join(
      root,
      "cli-runtimes",
      provider,
      `${plan.version}-${plan.sha256.slice(0, 12)}`,
    );
    expect(await readFile(join(directory, "LICENSE.md"), "utf8")).toBe(
      "official license fixture",
    );
    expect(await readdir(dirname(directory))).toEqual([
      directory.split(/[\\/]/).at(-1),
    ]);
    if (provider === "codex")
      expect((await ensureCodexAppServerBinary(paths())).source).toBe(
        "downloaded",
      );
    else if (provider === "claude")
      expect(await ensureClaudeBinary(paths())).toBe(executable);
  },
);

it("does not download for account polling, logout, or binary probes on a fresh install", async () => {
  expect(() => claudeBinary(paths())).toThrow(CliNotInstalledError);
  expect(() => resolveCodexAppServerBinary(paths())).toThrow(
    CliNotInstalledError,
  );
  await expect(readClaudeAccount(paths())).resolves.toMatchObject({
    authenticated: false,
    runtimeInstalled: false,
  });
  await expect(authenticateClaude(paths(), "logout")).resolves.toMatchObject({
    authenticated: false,
    runtimeInstalled: false,
  });
  expect(download).not.toHaveBeenCalled();
});

it("continues first use through both production binary adapters after installation", async () => {
  expect(await ensureClaudeBinary(paths(), {}, ensureManagedCli)).toBe(
    findManagedCli(root, "claude"),
  );
  expect(
    (await ensureCodexAppServerBinary(paths(), {}, ensureManagedCli))
      .executablePath,
  ).toBe(findManagedCli(root, "codex"));
  expect(download).toHaveBeenCalledTimes(2);
});

it("propagates an unsafe existing runtime instead of disguising it as a missing install", async () => {
  const executable = await ensureManagedCli(root, "claude");
  const outside = join(root, "user-data");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  const link = join(dirname(executable), "redirected");
  await symlink(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await expect(
      ensureClaudeBinary(paths(), {}, ensureManagedCli),
    ).rejects.toThrow("CLI cache link");
    expect(download).toHaveBeenCalledOnce();
  } finally {
    await rm(link);
  }
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
});

it("reuses existing bundled CLI files without modifying or downloading them", async () => {
  const claude = join(
    paths().resourcesDir,
    "claude",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  await mkdir(dirname(claude), { recursive: true });
  await writeFile(claude, "legacy");
  expect(await ensureClaudeBinary(paths())).toBe(claude);
  const codex = join(
    paths().resourcesDir,
    "c",
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  await mkdir(dirname(codex), { recursive: true });
  await writeFile(codex, "legacy");
  await writeFile(
    join(paths().resourcesDir, "c", "codex-package.json"),
    JSON.stringify({ version: "0.167.0" }),
  );
  expect((await ensureCodexAppServerBinary(paths())).executablePath).toBe(
    codex,
  );
  expect(download).not.toHaveBeenCalled();
  expect(await readFile(claude, "utf8")).toBe("legacy");
});

it("repairs an incomplete cache but never publishes an interrupted download", async () => {
  download.mockRejectedValueOnce(new Error("network interrupted"));
  await expect(ensureManagedCli(root, "claude")).rejects.toThrow(
    "network interrupted",
  );
  expect(findManagedCli(root, "claude")).toBeNull();
  expect(await readdir(join(root, "cli-runtimes", "claude"))).toEqual([]);
  const executable = await ensureManagedCli(root, "claude");
  await writeFile(executable, "broken");
  expect(findManagedCli(root, "claude")).toBeNull();
  await ensureManagedCli(root, "claude");
  expect(await readFile(executable, "utf8")).toBe(
    "official executable fixture",
  );
});

it("coalesces first use and allows an independent waiter to cancel", async () => {
  let complete!: (path: string) => void;
  download.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const first = ensureManagedCli(root, "codex");
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  const controller = new AbortController();
  const second = ensureManagedCli(root, "codex", { signal: controller.signal });
  const rejected = expect(second).rejects.toThrow("cancel waiter");
  controller.abort(new Error("cancel waiter"));
  await rejected;
  const third = ensureManagedCli(root, "codex");
  complete(archives.codex);
  expect(await third).toBe(await first);
  expect(download).toHaveBeenCalledOnce();
});

it("stops before download when cancelled and rejects mismatched package manifests", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    ensureClaudeBinary(paths(), { signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  await expect(
    ensureCodexAppServerBinary(paths(), { signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  expect(download).not.toHaveBeenCalled();
  download.mockResolvedValue(archives.codex);
  await expect(ensureManagedCli(root, "claude")).rejects.toThrow(
    "버전 또는 실행 파일",
  );
  expect(findManagedCli(root, "claude")).toBeNull();
});

it("never follows a redirected cache into user data", async () => {
  const outside = join(root, "preserve-me");
  await mkdir(outside);
  await writeFile(join(outside, "important.txt"), "keep");
  await symlink(
    outside,
    join(root, "cli-runtimes"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await expect(ensureManagedCli(root, "claude")).rejects.toThrow(
      "CLI cache link",
    );
    expect(await readFile(join(outside, "important.txt"), "utf8")).toBe("keep");
    expect(download).not.toHaveBeenCalled();
  } finally {
    await rm(join(root, "cli-runtimes"));
  }
});

it("discards a cancelled download before extraction and preserves authentication data", async () => {
  const controller = new AbortController();
  await mkdir(join(root, "codex"));
  await writeFile(join(root, "codex", "auth.json"), "do not change");
  download.mockImplementationOnce(async () => {
    controller.abort(new Error("cancel install"));
    return archives.codex;
  });
  await expect(
    ensureManagedCli(root, "codex", { signal: controller.signal }),
  ).rejects.toThrow("cancel install");
  expect(findManagedCli(root, "codex")).toBeNull();
  expect(await readdir(join(root, "cli-runtimes", "codex"))).toEqual([]);
  expect(await readFile(join(root, "codex", "auth.json"), "utf8")).toBe(
    "do not change",
  );
  await expect(ensureManagedCli(root, "codex")).resolves.toEqual(
    expect.any(String),
  );
});

it("repairs invalid or mismatched receipts and retries after an owner fails", async () => {
  const executable = await ensureManagedCli(root, "claude");
  const receipt = join(dirname(executable), ".installed.json");
  for (const value of [
    "not JSON",
    JSON.stringify({ sha256: "wrong", files: [] }),
  ]) {
    await writeFile(receipt, value);
    expect(findManagedCli(root, "claude")).toBeNull();
    await ensureManagedCli(root, "claude");
  }
  let fail!: (error: Error) => void;
  download.mockImplementationOnce(
    () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const owner = ensureManagedCli(root, "codex");
  const rejection = expect(owner).rejects.toThrow("owner failed");
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  const waiter = ensureManagedCli(root, "codex");
  fail(new Error("owner failed"));
  await rejection;
  await expect(waiter).resolves.toEqual(expect.any(String));
});

it("pins both released platforms and rejects an unknown download target", () => {
  for (const provider of ["claude", "codex"] as const)
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["darwin", "arm64"],
    ]) {
      const plan = cliRuntimePlan(provider, platform, arch);
      expect(plan.url.startsWith("https://registry.npmjs.org/@")).toBe(true);
      expect(plan.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  expect(() => cliRuntimePlan("codex", "freebsd", "x64")).toThrow(
    "지원하지 않는 플랫폼",
  );
});

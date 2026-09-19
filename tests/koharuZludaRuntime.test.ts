import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as yazl from "yazl";
import { ensureKoharuZludaRuntime } from "../src/main/inpainting/koharuZludaRuntime";
import {
  KOHARU_ZLUDA_SOURCE,
  type KoharuZludaSource,
} from "../src/main/inpainting/koharuZludaManifest";

const roots: string[] = [];
const dll = "cufft64_12.dll";
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "mgt-zluda-test-"));
  roots.push(runtimeRoot);
  const contents = Object.fromEntries(
    Object.keys(KOHARU_ZLUDA_SOURCE.dlls).map((name) => [
      name,
      Buffer.from(`normal:${name}`),
    ]),
  );
  const archive = await zipBytes(
    Object.entries(contents).flatMap(([name, data]) => [
      [`zluda/${name}`, data] as const,
      [`zluda/trace/${name}`, Buffer.from(`trace:${name}`)] as const,
    ]),
  );
  const source: KoharuZludaSource = {
    ...KOHARU_ZLUDA_SOURCE,
    bytes: archive.length,
    sha256: hash(archive),
    dlls: Object.fromEntries(
      Object.entries(contents).map(([name, data]) => [
        name,
        { bytes: data.length, sha256: hash(data) },
      ]),
    ),
  };
  const output = join(runtimeRoot, "runtime", "zluda");
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array(archive), {
        status: 200,
        headers: { "content-length": String(archive.length) },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return { runtimeRoot, source, contents, archive, output, fetch };
}

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(f.output, { recursive: true });
  for (const [name, data] of Object.entries(f.contents))
    await writeFile(join(f.output, name), data);
}

async function expectCleanRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await readdir(f.output)).sort()).toEqual(
    Object.keys(f.contents).sort(),
  );
  for (const [name, data] of Object.entries(f.contents))
    expect(await readFile(join(f.output, name))).toEqual(data);
  expect(
    (await readdir(join(f.runtimeRoot, "runtime"))).some((name) =>
      /^\.[sb]-/.test(name),
    ),
  ).toBe(false);
}

describe("Koharu AMD/ZLUDA managed runtime", () => {
  it("installs only canonical DLLs, not duplicate trace DLLs, using real ZIP extraction", async () => {
    const f = await fixture();
    await ensureKoharuZludaRuntime(f, f.source);
    await expectCleanRuntime(f);
    expect(f.fetch).toHaveBeenCalled();
  });

  it("reuses a fully hash-verified cache without accessing the network", async () => {
    const f = await fixture();
    await seed(f);
    await ensureKoharuZludaRuntime(f, f.source);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "empty", "same-size-corrupt", "directory", "trace"])(
    "repairs a %s cuFFT cache before launching the runner",
    async (mode) => {
      const f = await fixture();
      await seed(f);
      const path = join(f.output, dll);
      await rm(path);
      if (mode === "directory") await mkdir(path);
      else if (mode !== "missing")
        await writeFile(
          path,
          mode === "same-size-corrupt"
            ? Buffer.alloc(f.contents[dll].length, 0)
            : mode === "trace"
              ? "trace DLL"
              : "",
        );
      await writeFile(join(f.output, "cublas64_12.dll"), "stale native alias");
      await ensureKoharuZludaRuntime(f, f.source);
      await expectCleanRuntime(f);
    },
  );

  it("preserves the old cache and removes staging when a pinned archive lacks required DLLs", async () => {
    const f = await fixture();
    await seed(f);
    await writeFile(join(f.output, dll), "");
    const incomplete = await zipBytes([
      ["zluda/nvcuda.dll", f.contents["nvcuda.dll"]],
    ]);
    f.fetch.mockImplementation(
      async () =>
        new Response(new Uint8Array(incomplete), {
          headers: { "content-length": String(incomplete.length) },
        }),
    );
    await expect(
      ensureKoharuZludaRuntime(f, {
        ...f.source,
        bytes: incomplete.length,
        sha256: hash(incomplete),
      }),
    ).rejects.toThrow("integrity validation failed");
    expect(await readFile(join(f.output, dll), "utf8")).toBe("");
    expect(await readFile(join(f.output, "nvcuda.dll"))).toEqual(
      f.contents["nvcuda.dll"],
    );
    expect((await readdir(join(f.runtimeRoot, "runtime"))).sort()).toEqual([
      ".downloads",
      "zluda",
    ]);
  });

  it("does not touch an existing cache when already cancelled", async () => {
    const f = await fixture();
    await seed(f);
    await expect(
      ensureKoharuZludaRuntime({ ...f, signal: AbortSignal.abort() }, f.source),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await readFile(join(f.output, dll))).toEqual(f.contents[dll]);
  });
});

function hash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
async function zipBytes(
  entries: ReadonlyArray<readonly [string, Buffer]>,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  return result;
}

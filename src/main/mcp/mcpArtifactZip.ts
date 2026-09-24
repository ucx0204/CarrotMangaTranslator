import { McpEditError } from "../application/mcpEditPolicy";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { writeAtomicStreamingShareArchive } from "../libraryStore/shareStreamingZip";
import type { McpArtifactEntry } from "./mcpArtifactTypes";

/** Keep source entries alive through archive publication, then release only these leases. */
export async function createMcpArtifactZip<T>(
  files: { url: string; filename: string }[],
  resolve: (url: string) => Promise<McpArtifactEntry>,
  check: (entry: McpArtifactEntry) => Promise<void>,
  assertAccess: () => Promise<void>,
  manifest: unknown,
  signal: AbortSignal,
  publish: (
    reserved: number,
    assertAccess: () => Promise<void>,
    writer: (file: string) => Promise<{ bytes: number; sha256: string }>,
    bindings: McpArtifactEntry["bindings"],
  ) => Promise<T>,
): Promise<T> {
  assertMcpZipSelection(files);
  const sources: Parameters<typeof writeMcpArtifactZip>[0]["sources"] = [];
  const leased: McpArtifactEntry[] = [];
  try {
    for (const file of files) {
      if (!/^[0-9]+\.(png|jpg|webp|psd)$/.test(file.filename))
        throw unavailable();
      const entry = await resolve(file.url);
      if (
        entry.name === "pages.zip" ||
        file.filename.split(".").at(-1) !== entry.name.split(".").at(-1)
      )
        throw unavailable();
      entry.leases++;
      leased.push(entry);
      sources.push({
        file: entry.file,
        size: entry.size,
        filename: file.filename,
        check: () => check(entry),
      });
    }
    const assertArchiveAccess = async () => {
      await assertAccess();
      // A finished ZIP keeps source authority without depending on its old links.
      for (const entry of leased) await entry.assertAccess();
      await assertAccess();
    };
    return await publish(
      mcpZipBudget(sources, manifest),
      assertArchiveAccess,
      (file) =>
        writeMcpArtifactZip({
          file,
          sources,
          manifest,
          signal,
          assertAccess: assertArchiveAccess,
        }),
      leased.flatMap((entry) => entry.bindings),
    );
  } finally {
    for (const entry of leased) entry.leases--;
  }
}

/** Reuse the app's sequential, atomic ZIP writer, including its path/size budgets. */
async function writeMcpArtifactZip(options: {
  file: string;
  sources: {
    file: string;
    size: number;
    filename: string;
    check: () => Promise<void>;
  }[];
  manifest: unknown;
  signal: AbortSignal;
  assertAccess: () => Promise<void>;
}) {
  await writeAtomicStreamingShareArchive(
    {
      outputPath: options.file,
      archiveDate: new Date("2000-01-01T00:00:00Z"),
      signal: options.signal,
    },
    async (writer) => {
      for (const source of options.sources) {
        await options.assertAccess();
        await source.check();
        await writer.addFile(source.filename, {
          path: source.file,
          size: source.size,
        });
        await source.check();
      }
      await writer.addJson("manifest.json", options.manifest);
      await options.assertAccess();
    },
  );
  const hash = createHash("sha256");
  const stream = createReadStream(options.file, { signal: options.signal });
  for await (const chunk of stream) hash.update(chunk);
  await options.assertAccess();
  return { bytes: (await stat(options.file)).size, sha256: hash.digest("hex") };
}

function assertMcpZipSelection(files: { filename: string }[]) {
  if (
    !files.length ||
    files.length > 50 ||
    new Set(files.map((item) => item.filename)).size !== files.length
  )
    throw new McpEditError(
      "invalid_edit",
      "A ZIP requires 1 to 50 distinctly named PNG outputs.",
    );
}
export function mcpZipBudget(sources: { size: number }[], manifest: unknown) {
  const MAX_ZIP_BYTES = 128 * 1024 * 1024;
  const budget =
    sources.reduce((sum, item) => sum + item.size, 0) +
    Buffer.byteLength(JSON.stringify(manifest)) +
    1024 * 1024;
  if (budget > MAX_ZIP_BYTES)
    throw new McpEditError(
      "invalid_edit",
      "ZIP exceeds the 128 MiB output budget. Select fewer pages; resolution is never reduced.",
    );
  return budget;
}

function unavailable() {
  return new McpEditError(
    "not_found",
    "Output link is unavailable or expired. Inspect retained outputs or explicitly export again.",
  );
}

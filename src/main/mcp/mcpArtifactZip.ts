import { McpEditError } from "../application/mcpEditPolicy";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { writeAtomicStreamingShareArchive } from "../libraryStore/shareStreamingZip";

/** Reuse the app's sequential, atomic ZIP writer, including its path/size budgets. */
export async function writeMcpArtifactZip(options: {
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

export function assertMcpZipSelection(files: { filename: string }[]) {
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

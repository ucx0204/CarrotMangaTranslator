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

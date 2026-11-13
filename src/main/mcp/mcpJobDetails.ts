import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { sha256Bytes } from "../libraryStore/libraryTransactionStorage";
import { McpJobStorageFiles } from "./mcpJobStorageFiles";
import {
  JOB_DETAIL_BYTES,
  JOB_CHUNK_BYTES,
  JOB_CHUNK_FILE_BYTES,
  JOB_METADATA_BYTES,
  chunkSchema,
  detailManifestSchema,
  type JobCodec,
  type JobDetailReference,
  type JobBinding,
} from "./mcpJobStorageSchema";

export class McpJobDetails {
  constructor(
    private readonly files: McpJobStorageFiles,
    private readonly codec: JobCodec,
    readonly generation: string,
  ) {}
  directory(id: string, revision: string) {
    return `jobs-v2/${this.generation}/details/${id}/${revision}`;
  }
  async write(
    id: string,
    kind: "request" | "outcome",
    value: unknown,
  ): Promise<JobDetailReference> {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > JOB_DETAIL_BYTES)
      throw new Error("MCP job detail exceeds its capacity.");
    const revision = randomUUID();
    const directory = this.directory(id, revision);
    const binding = { generation: this.generation, jobId: id, kind, revision };
    const chunks = [];
    for (let start = 0; start < bytes.length; start += JOB_CHUNK_BYTES) {
      const part = String(chunks.length).padStart(3, "0");
      const chunk = bytes.subarray(start, start + JOB_CHUNK_BYTES);
      await this.files.write(
        `${directory}/${part}.enc`,
        await this.codec.seal(
          { ...binding, part },
          { data: chunk.toString("base64") },
        ),
        JOB_CHUNK_FILE_BYTES,
      );
      chunks.push({ bytes: chunk.length, sha256: sha256Bytes(chunk) });
    }
    const manifest = await this.codec.seal(
      { ...binding, part: "manifest" },
      { bytes: bytes.length, sha256: sha256Bytes(bytes), chunks },
    );
    await this.files.write(
      `${directory}/manifest.enc`,
      manifest,
      JOB_METADATA_BYTES,
    );
    return { revision, sha256: sha256Bytes(manifest), bytes: bytes.length };
  }
  async read(
    id: string,
    kind: "request" | "outcome",
    ref: JobDetailReference,
  ): Promise<unknown> {
    const { bytes } = await this.inspect(id, kind, ref);
    return JSON.parse(bytes.toString("utf8"));
  }
  async reclaim(id: string, revision: string) {
    z.uuid().parse(id);
    z.uuid().parse(revision);
    const directory = this.directory(id, revision);
    const raw = await this.files.read(
      `${directory}/manifest.enc`,
      JOB_METADATA_BYTES,
    );
    let authenticated:
      | {
          kind: "request" | "outcome";
          manifest: ReturnType<typeof detailManifestSchema.parse>;
        }
      | undefined;
    for (const kind of ["request", "outcome"] as const) {
      let value: unknown;
      try {
        value = await this.codec.open(
          {
            generation: this.generation,
            jobId: id,
            kind,
            revision,
            part: "manifest",
          },
          raw,
        );
      } catch (_error) {
        continue;
      } // The authenticated domain identifies one of these two detail kinds.
      const manifest = detailManifestSchema.parse(value);
      authenticated = { kind, manifest };
      break;
    }
    if (!authenticated)
      throw new Error("Unrecognized job detail; preserving it.");
    const names = await this.files.list(directory);
    const expectedNames = authenticated.manifest.chunks.map(
      (_, index) => `${String(index).padStart(3, "0")}.enc`,
    );
    for (const name of names) {
      if (name === "manifest.enc") continue;
      const index = expectedNames.indexOf(name);
      if (index < 0)
        throw new Error("Unknown job detail files; preserving directory.");
      const bytes = await this.chunk(directory, {
        generation: this.generation,
        jobId: id,
        kind: authenticated.kind,
        revision,
        part: name.slice(0, 3),
      });
      const expected = authenticated.manifest.chunks[index];
      if (
        bytes.length !== expected.bytes ||
        sha256Bytes(bytes) !== expected.sha256
      )
        throw new Error("Changed orphan chunk; preserving directory.");
    }
    // Authenticate every remaining file before deleting any. Manifest goes last,
    // so a crash halfway through cleanup can resume using its original hashes.
    for (const name of names.filter((name) => name !== "manifest.enc"))
      await this.files.remove(`${directory}/${name}`);
    await this.files.remove(`${directory}/manifest.enc`);
    await this.files.empty(directory);
  }
  async inspect(
    id: string,
    kind: "request" | "outcome",
    ref: JobDetailReference,
  ) {
    const directory = this.directory(id, ref.revision);
    const binding = {
      generation: this.generation,
      jobId: id,
      kind,
      revision: ref.revision,
    };
    const raw = await this.files.read(
      `${directory}/manifest.enc`,
      JOB_METADATA_BYTES,
    );
    if (sha256Bytes(raw) !== ref.sha256)
      throw new Error("Job manifest hash mismatch.");
    const manifest = detailManifestSchema.parse(
      await this.codec.open({ ...binding, part: "manifest" }, raw),
    );
    if (manifest.bytes !== ref.bytes)
      throw new Error("Job detail length mismatch.");
    const chunks: Buffer[] = [];
    const names = ["manifest.enc"];
    for (const [index, expected] of manifest.chunks.entries()) {
      const part = String(index).padStart(3, "0");
      const chunk = await this.chunk(directory, { ...binding, part });
      if (
        chunk.length !== expected.bytes ||
        sha256Bytes(chunk) !== expected.sha256
      )
        throw new Error("Job detail chunk mismatch.");
      chunks.push(chunk);
      names.push(`${part}.enc`);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== ref.bytes || sha256Bytes(bytes) !== manifest.sha256)
      throw new Error("Job detail hash mismatch.");
    return { bytes, directory, names };
  }
  private async chunk(directory: string, binding: JobBinding) {
    const raw = await this.files.read(
      `${directory}/${binding.part}.enc`,
      JOB_CHUNK_FILE_BYTES,
    );
    const { data } = chunkSchema.parse(await this.codec.open(binding, raw));
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.length > JOB_CHUNK_BYTES)
      throw new Error("Invalid job chunk encoding.");
    return bytes;
  }
}

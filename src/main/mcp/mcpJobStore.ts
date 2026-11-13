import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import {
  parseMcpJobJournal,
  parseMcpStoredJob,
  MCP_JOB_RETENTION_MS,
  type McpStoredJob,
} from "../application/mcpJobJournal";
import {
  summarizeMcpJob,
  type McpJobPersistence,
  type McpJobSummary,
} from "../application/mcpJobPersistence";
import { McpEditError } from "../application/mcpEditPolicy";
import { sha256Bytes } from "../libraryStore/libraryTransactionStorage";
import { McpJobStorageFiles, missing } from "./mcpJobStorageFiles";
import { McpJobDetails } from "./mcpJobDetails";
import {
  jobRootSchema,
  jobReceiptSchema,
  JOB_METADATA_BYTES,
  type JobReceipt,
  type JobRoot,
  type JobCodec,
} from "./mcpJobStorageSchema";

type RootPort = {
  load: () => Promise<unknown | null>;
  save: (value: unknown) => Promise<void>;
};

/** One small receipt is the commit point. The root never contains a growing catalog. */
export class McpJobStore implements McpJobPersistence {
  private root?: JobRoot;
  private details?: McpJobDetails;
  private readonly receipts = new Map<string, JobReceipt>();
  private readonly requests = new Map<string, string>();
  private lastSweep = -Infinity;
  private tail: Promise<unknown> = Promise.resolve();
  private initialized?: Promise<void>;
  private readonly files: McpJobStorageFiles;
  constructor(
    directory: string,
    private readonly codec: JobCodec,
    private readonly roots: RootPort,
    private readonly reportError: (error: unknown) => void,
    private readonly now = Date.now,
  ) {
    this.files = new McpJobStorageFiles(directory);
  }
  async open() {
    await (this.initialized ??= this.serial(() => this.initialize()));
    return [...this.receipts.values()].map(summary);
  }
  read(id: string) {
    return this.serial(() => this.readRecord(this.receipt(id)));
  }
  save(record: McpStoredJob, expectedRevision: number | null) {
    return this.serial(() => this.saveRecord(record, expectedRevision));
  }
  update(
    id: string,
    expectedRevision: number,
    changes: Pick<
      McpJobSummary,
      "status" | "cancellationRequested" | "finishedAt" | "expiresAt"
    >,
  ) {
    return this.serial(async () => {
      const previous = this.receipt(id);
      if (previous.revision !== expectedRevision)
        throw new Error("Job storage revision conflict.");
      const receipt = jobReceiptSchema.parse({
        ...previous,
        ...changes,
        revision: expectedRevision + 1,
      });
      await this.files.write(
        this.receiptPath(id),
        await this.codec.seal(this.binding(id), receipt),
        JOB_METADATA_BYTES,
      );
      this.receipts.set(id, receipt);
      return summary(receipt);
    });
  }
  remove(id: string, expectedRevision: number, now: number) {
    return this.serial(async () => {
      const receipt = this.receipt(id);
      if (
        receipt.revision !== expectedRevision ||
        receipt.expiresAt === undefined ||
        receipt.expiresAt > now
      )
        throw new Error("Job removal revision or expiry conflict.");
      const disk = await this.codec.open(
        this.binding(id),
        await this.files.read(this.receiptPath(id), JOB_METADATA_BYTES),
      );
      if (!isDeepStrictEqual(disk, receipt))
        throw new Error("Changed job receipt; preserving it.");
      await this.files.remove(this.receiptPath(id));
      this.receipts.delete(id);
      const key = JSON.stringify([receipt.owner, receipt.requestId]);
      if (this.requests.get(key) === id) this.requests.delete(key);
      await this.reclaim(receipt);
    });
  }
  cleanup(now: number) {
    return this.serial(async () => {
      if (now - this.lastSweep < 10 * 60_000) return;
      this.lastSweep = now;
      await this.sweepDetails();
      const legacy = this.root?.legacy;
      if (legacy && legacy.expiresAt <= now) {
        const path = `legacy-jobs/${legacy.sha256}.enc`;
        try {
          const raw = await this.files.read(path, 8 * 1024 * 1024);
          if (sha256Bytes(raw) !== legacy.sha256)
            throw new Error("Legacy job backup changed; preserving it.");
          await this.files.remove(path);
        } catch (error) {
          if (!missing(error)) this.reportError(error);
        }
      }
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.then(
      () => {},
      (_error) => {
        /* Caller owns the rejection; release serialization only. */
      },
    );
    return pending;
  }
  private async initialize() {
    const value = await this.roots.load();
    if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 2
    ) {
      this.configure(jobRootSchema.parse(value));
      await this.scan();
    } else {
      const records = value === null ? [] : parseMcpJobJournal(value);
      const root: JobRoot = {
        version: 2,
        generation: randomUUID(),
        createdAt: this.now(),
      };
      if (value !== null) root.legacy = await this.backupLegacy(root.createdAt);
      this.configure(root);
      await this.files.ensure(`jobs-v2/${root.generation}/receipts`);
      for (const record of records) {
        const { compacted: _compacted, ...original } = record;
        await this.saveRecord(original, null);
        if (
          !isDeepStrictEqual(
            await this.readRecord(this.receipt(record.id)),
            original,
          )
        )
          throw new Error("Job migration parity failed.");
      }
      await this.roots.save(root);
    }
  }
  private async backupLegacy(createdAt: number) {
    const raw = await this.files.read("jobs.enc", 8 * 1024 * 1024);
    const sha256 = sha256Bytes(raw);
    const path = `legacy-jobs/${sha256}.enc`;
    try {
      if (sha256Bytes(await this.files.read(path, 8 * 1024 * 1024)) !== sha256)
        throw new Error("Existing legacy backup changed.");
    } catch (error) {
      if (!missing(error)) throw error;
      await this.files.write(path, raw, 8 * 1024 * 1024);
    }
    if (sha256Bytes(await this.files.read(path, 8 * 1024 * 1024)) !== sha256)
      throw new Error("Legacy job backup verification failed.");
    return { sha256, expiresAt: createdAt + MCP_JOB_RETENTION_MS };
  }
  private configure(root: JobRoot) {
    this.root = root;
    this.details = new McpJobDetails(this.files, this.codec, root.generation);
  }
  private async scan() {
    const base = `jobs-v2/${this.generation()}/receipts`;
    await this.files.path(base);
    const requests = new Set<string>();
    for (const prefix of await this.files.list(base)) {
      if (!/^[a-f0-9]{2}$/.test(prefix))
        throw new Error("Unrecognized job receipt directory.");
      for (const name of await this.files.list(`${base}/${prefix}`)) {
        const id = z.uuid().parse(name.replace(/\.enc$/, ""));
        if (name !== `${id}.enc` || !id.startsWith(prefix))
          throw new Error("Invalid job receipt filename.");
        const raw = await this.files.read(
          `${base}/${prefix}/${name}`,
          JOB_METADATA_BYTES,
        );
        const receipt = jobReceiptSchema.parse(
          await this.codec.open(this.binding(id), raw),
        );
        if (receipt.id !== id || receipt.generation !== this.generation())
          throw new Error("Job receipt identity mismatch.");
        const key = JSON.stringify([receipt.owner, receipt.requestId]);
        const active =
          receipt.expiresAt === undefined || receipt.expiresAt > this.now();
        if (active && requests.has(key))
          throw new Error("Duplicate MCP job request identity.");
        if (active) {
          requests.add(key);
          this.requests.set(key, id);
        }
        this.receipts.set(id, receipt);
      }
    }
  }
  private async saveRecord(
    value: McpStoredJob,
    expectedRevision: number | null,
  ) {
    const record = parseMcpStoredJob(value);
    const previous = this.receipts.get(record.id);
    const key = JSON.stringify([record.owner, record.requestId]);
    const existing = this.requests.get(key);
    if (existing && existing !== record.id) this.assertExpired(existing);
    if ((previous?.revision ?? null) !== expectedRevision)
      throw new Error("Job storage revision conflict.");
    if (previous && !sameIdentity(previous, record))
      throw new Error("Job identity cannot change.");
    const request =
      previous?.request ??
      (await this.detailStore().write(record.id, "request", record.parameters));
    const outcome = await this.outcome(record, previous);
    const receipt = jobReceiptSchema.parse({
      ...summarizeMcpJob(record, (expectedRevision ?? 0) + 1),
      version: 2,
      generation: this.generation(),
      request,
      outcome,
    });
    await this.files.write(
      this.receiptPath(record.id),
      await this.codec.seal(this.binding(record.id), receipt),
      JOB_METADATA_BYTES,
    );
    this.receipts.set(record.id, receipt);
    this.requests.set(key, record.id);
    if (previous) await this.reclaimReplaced(previous, outcome.revision);
    return summary(receipt);
  }
  private assertExpired(id: string) {
    const expiresAt = this.receipt(id).expiresAt;
    if (expiresAt === undefined || expiresAt > this.now())
      throw new Error("Duplicate MCP request identity.");
  }
  private async reclaimReplaced(previous: JobReceipt, revision: string) {
    if (previous.outcome.revision !== revision)
      await this.reclaim(previous, ["outcome"]);
  }
  private async outcome(
    record: McpStoredJob,
    previous: JobReceipt | undefined,
  ) {
    const value = {
      progress: record.progress,
      result: record.result,
      error: record.error,
    };
    const details = this.detailStore();
    if (
      previous &&
      isDeepStrictEqual(
        await details.read(record.id, "outcome", previous.outcome),
        JSON.parse(JSON.stringify(value)),
      )
    )
      return previous.outcome;
    return details.write(record.id, "outcome", value);
  }
  private async readRecord(receipt: JobReceipt): Promise<McpStoredJob> {
    try {
      const parameters = await this.detailStore().read(
        receipt.id,
        "request",
        receipt.request,
      );
      const outcome = z
        .object({
          progress: z.unknown(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
        })
        .strict()
        .parse(
          await this.detailStore().read(receipt.id, "outcome", receipt.outcome),
        );
      const {
        revision: _revision,
        expiresAt: _expiresAt,
        ...identity
      } = summary(receipt);
      return parseMcpStoredJob({ ...identity, parameters, ...outcome });
    } catch (cause) {
      throw new McpEditError(
        "job_detail_unavailable",
        "Saved job details are unavailable. The request identity remains protected; do not repeat the operation.",
        { cause },
      );
    }
  }
  private async reclaim(
    receipt: JobReceipt,
    kinds: Array<"request" | "outcome"> = ["request", "outcome"],
  ) {
    for (const kind of kinds) {
      try {
        await this.detailStore().inspect(receipt.id, kind, receipt[kind]);
        await this.detailStore().reclaim(receipt.id, receipt[kind].revision);
      } catch (error) {
        this.reportError(error);
      }
    }
  }
  private async sweepDetails() {
    const base = `jobs-v2/${this.generation()}/details`;
    let processed = 0;
    for (const id of await this.files.list(base)) {
      try {
        await this.sweepJobDetails(base, id);
      } catch (error) {
        this.reportError(error);
      }
      if (++processed % 128 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  private async sweepJobDetails(base: string, id: string) {
    z.uuid().parse(id);
    const current = this.receipts.get(id);
    for (const revision of await this.files.list(`${base}/${id}`)) {
      if (
        revision === current?.request.revision ||
        revision === current?.outcome.revision
      )
        continue;
      await this.detailStore().reclaim(id, revision);
    }
    await this.files.empty(`${base}/${id}`);
  }
  private generation() {
    if (!this.root) throw new Error("Job store is not open.");
    return this.root.generation;
  }
  private detailStore() {
    if (!this.details) throw new Error("Job store is not open.");
    return this.details;
  }
  private receipt(id: string) {
    const value = this.receipts.get(z.uuid().parse(id));
    if (!value) throw new Error("Missing MCP job receipt.");
    return value;
  }
  private receiptPath(id: string) {
    z.uuid().parse(id);
    return `jobs-v2/${this.generation()}/receipts/${id.slice(0, 2)}/${id}.enc`;
  }
  private binding(id: string) {
    return {
      generation: this.generation(),
      jobId: id,
      kind: "receipt" as const,
      revision: "current",
      part: "receipt",
    };
  }
}
function summary(receipt: JobReceipt): McpJobSummary {
  const {
    version: _version,
    generation: _generation,
    request: _request,
    outcome: _outcome,
    ...value
  } = receipt;
  return value;
}
function sameIdentity(a: McpJobSummary, b: McpStoredJob) {
  return (
    a.owner === b.owner &&
    a.requestId === b.requestId &&
    a.kind === b.kind &&
    a.fingerprint === b.fingerprint &&
    a.startedAt === b.startedAt
  );
}

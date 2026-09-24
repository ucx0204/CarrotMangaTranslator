import type { McpArtifactMime } from "../../shared/mcpOutputFormats";
import { mcpArtifactRequiresImages } from "../../shared/mcpOutputFormats";
import type { McpOutputDeliveryMetadata } from "../../shared/mcpOutputDelivery";
import { McpEditError } from "../application/mcpEditPolicy";
import { readImageRedactionState } from "../imageRedactionStore";
import { readRetainedOutput, checkOutputPages } from "./mcpRetainedOutputs";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { RetainedOutput } from "./mcpRetentionRecords";

type Diagnosis = {
  storage: McpRetentionStorage;
  owner: string;
  id: string;
  check: () => void;
  images: boolean;
  authorizeFormat: (mime: McpArtifactMime) => void;
};

/** Called under the catalog read lock; ownership precedes every evidence read. */
export async function diagnoseRetainedOutput(
  input: Diagnosis,
): Promise<McpOutputDeliveryMetadata> {
  const { storage, owner, id, check } = input;
  const entry = (await storage.index()).entries.find(
    (item) => item.id === id && item.owner === owner && item.kind === "output",
  );
  check();
  if (!entry)
    throw new McpEditError(
      "not_found",
      "Retained output is not owned by this connection.",
    );
  const report: McpOutputDeliveryMetadata = {
    generation: { status: "unknown" },
    retention: {
      state: "unavailable",
      content: "not_checked",
      source: "not_checked",
      access: "blocked",
      checkedAt: storage.now(),
      expiresAt: entry.expiresAt,
    },
  };
  if (entry.expiresAt <= storage.now()) {
    report.retention.state = "expired";
    return report;
  }
  const record = await readDiagnosisRecord(input, report, entry.expiresAt);
  if (!record) return report;
  report.artifact = {
    mimeType: record.mimeType,
    bytes: record.bytes,
    sha256: record.sha256,
    retainedOutputId: id,
  };
  report.retention.state = "retained";
  await diagnoseSources(record, report, check);
  await diagnoseContent(input, record, report);
  await diagnoseAccess(input, record, report);
  check();
  if (entry.expiresAt <= storage.now()) {
    report.retention.state = "expired";
    report.retention.access = "blocked";
  }
  report.retention.checkedAt = storage.now();
  return report;
}

async function readDiagnosisRecord(
  input: Diagnosis,
  report: McpOutputDeliveryMetadata,
  expiresAt: number,
) {
  try {
    return (await readRetainedOutput(input.storage, input.owner, input.id))
      .record;
  } catch (error) {
    input.check();
    // Unreadable owned records expose no verified evidence or filesystem detail.
    void error;
    if (expiresAt <= input.storage.now()) report.retention.state = "expired";
    return undefined;
  }
}

async function diagnoseSources(
  record: RetainedOutput,
  report: McpOutputDeliveryMetadata,
  check: () => void,
) {
  try {
    await checkOutputPages(record, true, check);
    report.retention.source = "current";
  } catch (error) {
    check();
    if (
      error instanceof McpEditError &&
      (error.code === "revision_conflict" || error.code === "not_found")
    )
      report.retention.source = "stale";
  }
}

async function diagnoseContent(
  input: Diagnosis,
  record: RetainedOutput,
  report: McpOutputDeliveryMetadata,
) {
  try {
    const payload = await inspectRetainedFile(
      await input.storage.path(input.id, record.sha256),
    );
    report.retention.content =
      payload.sha256 === record.sha256 && payload.bytes === record.bytes
        ? "verified"
        : "mismatch";
  } catch (error) {
    input.check();
    if (
      error instanceof McpEditError &&
      (error.code === "revision_conflict" || error.code === "invalid_edit")
    )
      report.retention.content = "mismatch";
    else report.retention.state = "unavailable";
  }
}

async function diagnoseAccess(
  input: Diagnosis,
  record: RetainedOutput,
  report: McpOutputDeliveryMetadata,
) {
  input.check();
  if (
    report.retention.source !== "current" ||
    report.retention.content !== "verified"
  )
    return;
  try {
    input.authorizeFormat(record.mimeType);
    const images = mcpArtifactRequiresImages(record.mimeType);
    if (!images || (input.images && !(await readImageRedactionState()).enabled))
      report.retention.access = "allowed";
    input.authorizeFormat(record.mimeType);
  } catch (error) {
    input.check();
    // Permission and unknown access-check failures both deny the capability.
    void error;
    report.retention.access = "blocked";
  }
}

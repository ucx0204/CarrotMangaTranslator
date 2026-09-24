import {
  McpExchangeFileArtifactSchema,
  mcpExchangeIdentity,
  type McpTextExchangeBinding,
} from "../../shared/mcpExchangeFiles";
import type {
  McpTextExportReview,
  McpTextExportReviewInput,
  McpTextExportTarget,
} from "../../shared/mcpTextExchange";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpOperationContext } from "./mcpOperationService";
import { McpEditError } from "./mcpEditPolicy";

type Artifact = {
  url: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  expiresAt: number;
  access: string;
  retainedOutputId?: string;
};
type Ports = {
  read: (
    input: McpTextExportReviewInput,
    guard: () => void,
    signal?: AbortSignal,
  ) => Promise<{
    binding: McpTextExchangeBinding;
    review: McpTextExportReview;
    bytes: Buffer;
    verifySources: () => Promise<void>;
  }>;
  store: (
    bytes: Buffer,
    binding: McpTextExchangeBinding,
    access: () => Promise<void>,
    signal: AbortSignal,
  ) => Promise<Artifact>;
};
export class McpTextExportService {
  constructor(private readonly ports: Ports) {}
  async preflight(input: McpTextExportReviewInput, guard: () => void) {
    const source = await this.ports.read(input, guard);
    await source.verifySources();
    guard();
    return source.review;
  }
  async run(
    target: McpTextExportTarget,
    job: McpOperationContext,
    guard: () => void,
  ) {
    job.assertAuthorized();
    const source = await this.ports.read(
      {
        chapterId: target.binding.chapterId,
        pageIds: target.binding.pages.map((page) => page.pageId),
        options: target.binding.options,
      },
      guard,
      job.signal,
    );
    if (hashStableValue(source.binding) !== hashStableValue(target.binding))
      throw new McpEditError(
        "revision_conflict",
        "The reviewed text export changed; repeat preflight.",
      );
    if (!source.bytes.length)
      throw new McpEditError(
        "invalid_edit",
        "The native TXT selection is empty. Select pages/fields containing text.",
      );
    const access = async () => {
      guard();
      await source.verifySources();
      guard();
    };
    job.progress({
      phase: "serializing",
      completed: 0,
      total: source.review.pageCount,
    });
    const file = await this.ports.store(
      source.bytes,
      source.binding,
      access,
      job.signal,
    );
    await access();
    job.assertAuthorized();
    job.progress({
      phase: "done",
      completed: source.review.pageCount,
      total: source.review.pageCount,
    });
    return McpExchangeFileArtifactSchema.parse({
      ...file,
      kind: "exchange-file",
      exchange: source.binding,
      filename: `carrot-${mcpExchangeIdentity(source.binding).name}`,
      performed: ["serialize", "export"],
    });
  }
}

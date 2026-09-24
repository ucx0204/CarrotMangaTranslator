import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { McpCompositeImportPreflightSchema } from "../../shared/mcpCompositeWorkflow";
import {
  McpCompositeGetSchema,
  McpCompositeListSchema,
  McpCompositeReviewGetSchema,
  McpCompositeEvidenceGetSchema,
  McpCompositeNativeReviewSchema,
  mcpCompositeWorkflowOutputs,
} from "../../shared/mcpCompositeWorkflowOutputs";
import {
  compositeWorkflowView,
  compositeWorkflowList,
  compositeWorkflowReview,
  compositeReviewPhase,
} from "../application/mcpCompositeWorkflowProjection";
import { McpEditError } from "../application/mcpEditPolicy";
import { createMcpBatchTool } from "./mcpBatchTool";
import { textContent, type McpTool } from "./mcpReadTools";
import type { McpCompositeToolPort } from "./mcpCompositeToolPorts";
import { authorizeMcpComposite } from "./mcpCompositeAuthorization";

const scopes = ["carrot.read"];

export function createMcpCompositeReadTools(
  options: McpCompositeToolPort,
): McpTool[] {
  const { service } = options;
  return [
    createMcpBatchTool({
      name: "carrot_preflight_composite_import",
      schema: McpCompositeImportPreflightSchema,
      scopes,
      write: false,
      description:
        "Read the exact reviewed item mapping for an existing owned image-import preview or work-file upload. Returns opaque item keys and the source selection fingerprint for a reviewed-import composite target envelope. The closed action input is inspected only: no publication, picker, network, model, job admission, upload consumption or plan reservation.",
      execute: (args, owner, guard, authorize) =>
        options.importPreflight(
          owner,
          McpCompositeImportPreflightSchema.parse(args),
          authorizeMcpComposite(guard, authorize),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_composite",
      schema: McpCompositeGetSchema,
      scopes,
      write: false,
      description:
        "Read this connection's exact bounded parent plan, target envelope, current snapshot/version, native child receipts, usage and phase states. Metadata only; native inputs, filesystem paths, image bytes and capability URLs are excluded. Historical running work is exposed as interrupted/held after restart. No execution or automatic recovery.",
      execute: async (args, owner, guard) =>
        compositeWorkflowView(
          await service.get(owner, McpCompositeGetSchema.parse(args).id, guard),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_list_composites",
      schema: McpCompositeListSchema,
      scopes,
      write: false,
      description:
        "List this owner's unexpired seven-day composite metadata with snapshot pagination, at most 25 parents per response. No image transfer, source readback, child execution or cross-owner takeover.",
      execute: async (args, owner, guard) =>
        compositeWorkflowList(
          await options.list(owner, guard),
          McpCompositeListSchema.parse(args),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_composite_review",
      schema: McpCompositeReviewGetSchema,
      scopes,
      write: false,
      description:
        "Inspect issued render evidence identities and this review phase's host-reported findings, at most 25 findings per response. This metadata response is not visual observation or a native translation-quality verdict. Retrieve each required image with get_composite_review_image before submitting an assessment. Historical evidence metadata remains distinct from current image availability.",
      execute: async (args, owner, guard) => {
        const input = McpCompositeReviewGetSchema.parse(args);
        return compositeWorkflowReview(
          await service.get(owner, input.id, guard),
          input.phaseId,
          input,
        );
      },
    }),
    nativeReviewTool(options),
    evidenceTool(options),
  ];
}

function nativeReviewTool(options: McpCompositeToolPort): McpTool {
  return createMcpBatchTool({
    name: "carrot_get_composite_native_review",
    schema: McpCompositeNativeReviewSchema,
    scopes,
    write: false,
    description:
      "Inspect existing native saved-page metadata concerns only for the parent's exact selected pages, with at most 25 returned pages. Counts cover each whole selected page even when editing is restricted to chosen blocks. Rechecks the current parent source/policy snapshot. No rendering, model, app export preflight, library edit or quality judgment; explicitly reports the unchecked areas. A pre-import parent can have zero saved pages.",
    execute: async (args, owner, guard, authorize) => {
      const input = McpCompositeNativeReviewSchema.parse(args);
      const check = authorizeMcpComposite(guard, authorize);
      return options.inspectMetadata(
        await options.service.get(owner, input.id, check),
        input,
        check,
      );
    },
  });
}

function evidenceTool(options: McpCompositeToolPort): McpTool {
  return createMcpBatchTool({
    name: "carrot_get_composite_review_image",
    schema: McpCompositeEvidenceGetSchema,
    scopes: ["carrot.read", "carrot.images"],
    write: false,
    description:
      "Return one already issued actual rendered PNG, with exact phase/pass/page revision, SHA-256 and pixel mapping. Rechecks current saved source/settings/fonts, image permission and redaction. No rerender, model or output export is triggered by retrieval. Preview bytes are session-only and can expire; unavailable evidence remains unavailable. The image proves what was issued, not that the connected AI perceived it or that its quality judgment is correct.",
    execute: async (args, owner, guard, authorize) => {
      const input = McpCompositeEvidenceGetSchema.parse(args);
      const check = authorizeMcpComposite(guard, authorize);
      const record = await options.service.get(owner, input.id, check);
      const issued = compositeReviewPhase(record, input.phaseId).evidence?.find(
        (item) => item.id === input.evidenceId,
      );
      if (!issued)
        throw new McpEditError(
          "not_found",
          "No such rendered evidence was issued for this owned review phase.",
        );
      const result = await options.readEvidence(
        record,
        input.evidenceId,
        check,
      );
      if (
        !isDeepStrictEqual(result.evidence, issued) ||
        !Buffer.isBuffer(result.bytes) ||
        createHash("sha256").update(result.bytes).digest("hex") !==
          issued.sha256
      )
        throw new McpEditError(
          "revision_conflict",
          "Rendered review evidence no longer matches its issued bytes.",
        );
      check(["carrot.read", "carrot.images"]);
      const { owner: _owner, ...evidence } = issued;
      return {
        metadata:
          mcpCompositeWorkflowOutputs.carrot_get_composite_review_image.parse({
            id: record.id,
            version: record.version,
            evidence,
            verification: "current-source-and-permission-rechecked",
            qualityVerdict: "host-assessment-required",
          }),
        bytes: result.bytes,
      };
    },
    formatResult: ({ metadata, bytes }) => [
      ...textContent(metadata),
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ],
  });
}

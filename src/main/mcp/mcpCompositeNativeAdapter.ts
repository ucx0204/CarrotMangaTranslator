import type {
  McpCompositeGuard,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import { McpCompositeNativeCalls } from "./mcpCompositeNativeCalls";
import { McpCompositeNativeReview } from "./mcpCompositeNativeReview";
import { McpCompositeNativeResolver } from "./mcpCompositeNativeResolver";
import type { CompositeNativeOptions } from "./mcpCompositeNativeResolve";

/** One typed controller adapter around the application's existing session authorities. */
export function createMcpCompositeNative(options: CompositeNativeOptions) {
  const calls = new McpCompositeNativeCalls(options);
  const resolver = new McpCompositeNativeResolver(options, calls);
  const review = new McpCompositeNativeReview(options.tools, resolver.sources);
  return {
    prepare: resolver.prepare,
    resolve: resolver.resolve,
    verify: resolver.verify,
    execute: resolver.execute,
    reconcile: resolver.reconcile,
    refresh: resolver.refresh,
    control: calls.control,
    importPreflight: resolver.importPreflight.bind(resolver),
    verifySnapshot: (record: McpCompositeRecord, guard: McpCompositeGuard) =>
      resolver.verifySnapshot(record, guard),
    renderEvidence: review.renderEvidence,
    verifyEvidence: review.verifyEvidence,
    verifyReviewReport: review.verifyReviewReport,
    readEvidence: review.readEvidence.bind(review),
    stop: () => {
      resolver.close();
      review.close();
    },
    close: async () => {
      resolver.close();
      review.close();
    },
  };
}

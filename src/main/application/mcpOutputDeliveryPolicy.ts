import { z } from "zod/v4";
import {
  McpOutputDeliveryMetadataSchema,
  McpOutputDeliveryObservationSchema,
  McpOutputDeliveryReportSchema,
  type McpGetOutputDelivery,
  type McpOutputDeliveryTarget,
} from "../../shared/mcpOutputDelivery";
import { McpEditError } from "./mcpEditPolicy";

const observationReference = z
  .object({
    artifactKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    retainedOutputId: z.string().uuid().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.artifactKey || value.retainedOutputId));
/** Native-only lookup identity; never accepted from a public tool request. */
export type McpDeliveryObservationReference = z.infer<
  typeof observationReference
>;
export type McpOutputDeliveryPorts = {
  resolve: (
    owner: string,
    target: McpOutputDeliveryTarget,
    guard: () => void,
    assertAdditionalScopes: (scopes: readonly string[]) => void,
  ) => Promise<{
    metadata: unknown;
    observation?: McpDeliveryObservationReference;
  }>;
  observe: (reference: McpDeliveryObservationReference) => unknown;
  now?: () => number;
};

/** Ownership and payload policy stay in the injected native resolver. */
export class McpOutputDeliveryService {
  constructor(private readonly ports: McpOutputDeliveryPorts) {}

  async inspect(
    owner: string,
    input: McpGetOutputDelivery,
    guard: () => void,
    assertAdditionalScopes: (
      scopes: readonly string[],
    ) => void = unavailableScope,
  ) {
    guard();
    const resolved = await this.ports.resolve(
      owner,
      input.target,
      guard,
      assertAdditionalScopes,
    );
    guard();
    const metadata = McpOutputDeliveryMetadataSchema.safeParse(
      resolved.metadata,
    );
    if (!metadata.success) throw unavailable();
    const reference =
      resolved.observation === undefined
        ? undefined
        : observationReference.safeParse(resolved.observation);
    if (reference && !reference.success) throw unavailable();
    const checkedAt = (this.ports.now ?? Date.now)();
    const observation = McpOutputDeliveryObservationSchema.safeParse(
      reference?.success
        ? this.ports.observe(reference.data)
        : { state: "not_observed", checkedAt, historyComplete: false },
    );
    guard();
    if (!observation.success) throw unavailable();
    const report = McpOutputDeliveryReportSchema.safeParse({
      ...metadata.data,
      target: input.target,
      checkedAt,
      observation: observation.data,
      clientReceipt: "unconfirmed",
    });
    if (!report.success) throw unavailable();
    return report.data;
  }
}
function unavailableScope(scopes: readonly string[]): void {
  if (scopes.length)
    throw new McpEditError(
      "access_denied",
      "Additional output permission is unavailable.",
    );
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "Output delivery metadata is unavailable for this connection.",
  );
}

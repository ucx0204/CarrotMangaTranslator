import type { McpPageWindow } from "../application/mcpLibraryReadService";

export class McpInvalidParams extends Error {
  constructor() {
    super("Invalid tool arguments. Follow the tool's input schema.");
  }
}

export function argumentObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new McpInvalidParams();
  return value as Record<string, unknown>;
}

export function allowArguments(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new McpInvalidParams();
}

const ID_PATTERN = "^[A-Za-z0-9_-]{1,128}$";
export const identifierSchema = { type: "string", pattern: ID_PATTERN };
export const windowProperties = {
  offset: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
};

export function readIdentifier(value: unknown): string {
  if (typeof value !== "string" || !new RegExp(ID_PATTERN).test(value))
    throw new McpInvalidParams();
  return value;
}

export function readWindow(args: Record<string, unknown>): McpPageWindow {
  const offset = args.offset === undefined ? windowProperties.offset.default : args.offset;
  const limit = args.limit === undefined ? windowProperties.limit.default : args.limit;
  return {
    offset: readInteger(offset, windowProperties.offset),
    limit: readInteger(limit, windowProperties.limit),
  };
}

function readInteger(
  value: unknown,
  bounds: { minimum: number; maximum: number },
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < bounds.minimum ||
    value > bounds.maximum
  )
    throw new McpInvalidParams();
  return value;
}

export function readQuery(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 200)
    throw new McpInvalidParams();
  return value;
}

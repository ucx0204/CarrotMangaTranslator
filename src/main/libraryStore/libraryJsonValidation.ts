import type { z } from "zod";

export function readLibraryJsonFile<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "payload";
  const message = issue
    ? `${path}: ${issue.message}`
    : "unknown validation error";
  throw new Error(`보관함 파일 형식이 올바르지 않습니다. ${message}`);
}

export function assertUniqueIds(ids: string[], message: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(message);
  }
}

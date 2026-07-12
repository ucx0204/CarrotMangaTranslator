import { z } from "zod";
import type { MangaApi } from "./mangaApi";

export type IpcContract<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> = {
  apiKey: keyof MangaApi;
  channel: string;
  args: z.ZodType<unknown>;
  result: z.ZodType<unknown>;
  _args?: TArgs;
  _result?: TResult;
};

export type IpcEventContract<TPayload = unknown> = {
  eventKey: string;
  channel: string;
  payload: z.ZodType<unknown>;
  _payload?: TPayload;
};

export function defineIpcContract<TArgs extends unknown[], TResult>(
  contract: Omit<IpcContract<TArgs, TResult>, "_args" | "_result">,
): IpcContract<TArgs, TResult> {
  return contract;
}

export function defineIpcEventContract<TPayload>(
  contract: Omit<IpcEventContract<TPayload>, "_payload">,
): IpcEventContract<TPayload> {
  return contract;
}

export const MAX_PATH_LENGTH = 4096;
export const MAX_TITLE_LENGTH = 240;
export const MAX_ID_LIST_LENGTH = 2000;
export const MAX_PAGES_PER_REQUEST = 2000;
export const MAX_BLOCKS_PER_RESULT = 500;
export const MAX_WARNINGS = 500;
const MAX_DIAGNOSTIC_LENGTH = 100000;

export const stringArg = z.string().min(1).max(MAX_PATH_LENGTH);
export const titleString = z.string().max(MAX_TITLE_LENGTH);
export const diagnosticString = z.string().max(MAX_DIAGNOSTIC_LENGTH);
export const stringListArg = z
  .array(z.string().min(1).max(MAX_PATH_LENGTH))
  .max(MAX_ID_LIST_LENGTH);
export const nonNegativeInteger = z.number().int().min(0);
export const localPathResult = z.string().min(1).max(MAX_PATH_LENGTH);
export const analysisResultStatusSchema = z.enum([
  "completed",
  "cancelled",
  "failed",
]);

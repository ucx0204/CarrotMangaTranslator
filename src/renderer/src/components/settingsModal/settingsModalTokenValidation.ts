import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "../../../../shared/modelPresets";

export function isValidMaxTokens(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_MAX_TOKENS &&
    value <= MAX_MAX_TOKENS
  );
}

export function isValidContextTokens(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CONTEXT_TOKENS;
}

import { randomUUID } from "node:crypto";
import type {
  CharacterProfile,
  GlossaryEntry,
} from "../shared/workContextTypes";

export function glossaryPrevious(
  existing: GlossaryEntry | undefined,
  timestamp: string,
) {
  if (existing) return existing;
  return {
    id: randomUUID(),
    source: "",
    target: "",
    category: "term" as const,
    aliases: undefined,
    note: undefined,
    createdAt: timestamp,
  };
}

export function characterPrevious(
  existing: CharacterProfile | undefined,
  timestamp: string,
) {
  if (existing) return existing;
  return {
    id: randomUUID(),
    displayName: "",
    sourceNames: [] as string[],
    targetName: "",
    aliases: undefined,
    speechStyle: "neutral" as const,
    customSpeechStyle: undefined,
    note: undefined,
    createdAt: timestamp,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

import { join } from "node:path";
import type { WorkTypographyProfileV2 } from "../../shared/fontMatchingProfileTypes";
import {
  migrateWorkTypographyProfile,
  normalizeWorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileCodec";
import { ensureExistingWork } from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { assertSafeStoreId } from "./libraryStoreIds";
import { readJsonFile, writeJsonFile } from "./storage";

export const WORK_TYPOGRAPHY_PROFILE_FILE_NAME = "typography-profile.json";

export function getWorkTypographyProfilePath(workId: string): string {
  assertSafeStoreId(workId, "작품 ID가 올바르지 않습니다.");
  return join(getWorksRoot(), workId, WORK_TYPOGRAPHY_PROFILE_FILE_NAME);
}

export async function readWorkTypographyProfile(
  workId: string,
): Promise<WorkTypographyProfileV2 | null> {
  await ensureExistingWork(workId);
  const raw = await readProfileJson(workId);
  if (raw === null) {
    return null;
  }
  const profile = parseStoredProfile(raw);
  assertProfileLocation(workId, profile);
  return profile;
}

export async function writeWorkTypographyProfile(
  profile: WorkTypographyProfileV2,
): Promise<WorkTypographyProfileV2> {
  await ensureExistingWork(profile.workId);
  const checked = normalizeWorkTypographyProfileV2(profile);
  assertProfileLocation(profile.workId, checked);
  await writeJsonFile(getWorkTypographyProfilePath(checked.workId), checked);
  return checked;
}

async function readProfileJson(workId: string): Promise<unknown | null> {
  try {
    return await readJsonFile<unknown | null>(
      getWorkTypographyProfilePath(workId),
      null,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${WORK_TYPOGRAPHY_PROFILE_FILE_NAME} JSON을 읽지 못했습니다. ${message}`,
      { cause: error },
    );
  }
}

function parseStoredProfile(payload: unknown): WorkTypographyProfileV2 {
  try {
    return migrateWorkTypographyProfile(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${WORK_TYPOGRAPHY_PROFILE_FILE_NAME} 형식이 올바르지 않습니다. ${message}`,
      { cause: error },
    );
  }
}

function assertProfileLocation(
  expectedWorkId: string,
  profile: WorkTypographyProfileV2,
): void {
  if (profile.workId !== expectedWorkId) {
    throw new Error("작품 글꼴 프로필의 보관함 위치가 올바르지 않습니다.");
  }
}

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEMOTED_BLOCK_FONTS } from "../shared/demotedBlockFonts";
import { assertFontFileLooksValid } from "./customFontFileValidation";

/** Copy only fonts present in an earlier installation. Never download a removed font. */
export function preserveDemotedFonts(
  fontsDir: string,
  bundledFontsDir: string,
): void {
  const indexPath = join(fontsDir, "index.json");
  const records: unknown = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : [];
  if (!Array.isArray(records))
    throw new Error("Invalid custom font index during migration.");
  let changed = false;
  for (const font of DEMOTED_BLOCK_FONTS) {
    if (records.some((entry) => entry?.id === font.customId)) continue;
    const source = join(bundledFontsDir, "ko", `${font.id}.ttf`);
    if (!existsSync(source)) continue;
    if (!statSync(source).isFile())
      throw new Error("Legacy font is not a file.");
    assertFontFileLooksValid(source, ".ttf");
    mkdirSync(fontsDir, { recursive: true });
    const fileName = `${font.customId}.ttf`;
    const target = join(fontsDir, fileName);
    // An interrupted migration may already have copied the exact original.
    if (existsSync(target)) {
      if (!readFileSync(source).equals(readFileSync(target)))
        throw new Error(
          "Legacy font migration target contains different bytes.",
        );
    } else copyFileSync(source, target);
    records.push({
      id: font.customId,
      label: font.label,
      family: `MGTUser-${font.customId}`,
      fileName,
    });
    changed = true;
  }
  if (!changed) return;
  const staging = `${indexPath}.${randomUUID()}.tmp`;
  writeFileSync(staging, JSON.stringify(records, null, 2), "utf8");
  renameSync(staging, indexPath);
}

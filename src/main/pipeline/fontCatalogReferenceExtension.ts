import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import artifact from "./fontCatalogReferenceExtension.json";

const BANK_SHA256 =
  "7726bdc2cf84069d268168feb953eed7bd53c921434fd1d9d533c58381cb849e";

export function readAdditionalFontReferenceBank() {
  const bytes = gunzipSync(Buffer.from(artifact.bankGzipBase64, "base64"), {
    maxOutputLength: 4 * 24 * 96 * 96,
  });
  if (
    artifact.schema !== "font-catalog-reference-extension-v1" ||
    bytes.length !== artifact.bankByteSize ||
    artifact.bankSha256 !== BANK_SHA256 ||
    createHash("sha256").update(bytes).digest("hex") !== BANK_SHA256
  )
    throw new Error("Additional font reference bank integrity check failed.");
  return { bytes, faces: artifact.faces };
}

export function additionalFontCoverage(fontId: string) {
  const face = artifact.faces.find((candidate) => candidate.fontId === fontId);
  return face?.unicodeRanges.map(([start, end]) => [start, end] as const);
}

/** Check every actual face, including Shilla Bold, before making the new palette selectable. */
export function verifyAdditionalFontFiles(roots: readonly string[]): void {
  readAdditionalFontReferenceBank();
  for (const face of artifact.faces) {
    let verified = false;
    for (const root of roots) {
      const bytes = readOptionalFont(join(root, face.file));
      if (!bytes) continue;
      if (
        bytes.length !== face.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== face.sha256
      )
        throw new Error(
          `Font reference and installed font differ: ${face.file}`,
        );
      verified = true;
      break;
    }
    if (!verified)
      throw new Error(`Additional font is not installed: ${face.file}`);
  }
}

function readOptionalFont(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

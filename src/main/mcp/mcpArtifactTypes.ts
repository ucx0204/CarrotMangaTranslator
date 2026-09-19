export type McpArtifactBinding = {
  chapterId: string;
  pageId: string;
  revision: string;
  sourceFingerprint?: string;
};
export type McpArtifactRetention = (
  artifact: {
    file: string;
    mimeType: "image/png" | "application/zip";
    sha256: string;
    size: number;
    bindings: McpArtifactBinding[];
  },
  assertAccess: () => Promise<void>,
) => Promise<string>;
export type McpArtifactEntry = {
  bindings: McpArtifactBinding[];
  retainedOutputId?: string;
  borrowed?: boolean;
  verifyOpen?: () => Promise<void>;
  file: string;
  name: "page.png" | "pages.zip";
  mimeType: "image/png" | "application/zip";
  sha256: string;
  expiresAt: number;
  size: number;
  leases: number;
  assertAccess: () => Promise<void>;
};

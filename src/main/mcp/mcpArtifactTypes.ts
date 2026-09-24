import type { McpArtifactMime } from "../../shared/mcpOutputFormats";
import type { McpWorkFileExportBinding } from "../../shared/mcpWorkFileExport";
import type { McpExchangeBinding } from "../../shared/mcpExchangeFiles";

export type McpArtifactBinding = {
  chapterId: string;
  pageId: string;
  revision: string;
  sourceFingerprint?: string;
  sourceNameFingerprint?: string;
};
export type McpArtifactRetention = (
  artifact: {
    file: string;
    mimeType: McpArtifactMime;
    sha256: string;
    size: number;
    bindings: McpArtifactBinding[];
    workFileBinding?: McpWorkFileExportBinding;
    exchangeBinding?: McpExchangeBinding;
    signal?: AbortSignal;
  },
  assertAccess: () => Promise<void>,
) => Promise<string>;
export type McpRetainedArtifactMetadata = {
  mimeType: McpArtifactMime;
  bytes: number;
  sha256: string;
  bindings?: McpArtifactBinding[];
  workFileBinding?: McpWorkFileExportBinding;
  exchangeBinding?: McpExchangeBinding;
  retainedOutputId?: string;
};
export type McpArtifactEntry = {
  bindings: McpArtifactBinding[];
  workFileBinding?: McpWorkFileExportBinding;
  exchangeBinding?: McpExchangeBinding;
  signal?: AbortSignal;
  retainedOutputId?: string;
  borrowed?: boolean;
  verifyOpen?: () => Promise<void>;
  file: string;
  name:
    | "page.png"
    | "page.jpg"
    | "page.webp"
    | "page.psd"
    | "pages.zip"
    | "work.mgtshare"
    | "text.txt"
    | "review.csv"
    | "review.tsv"
    | "context.json";
  mimeType: McpArtifactMime;
  sha256: string;
  expiresAt: number;
  size: number;
  leases: number;
  assertAccess: () => Promise<void>;
};

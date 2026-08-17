import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { JWT } from "google-auth-library";
import type { VertexServiceAccountPickResult } from "../shared/apiProviderPresets";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const MAX_CREDENTIAL_FILE_BYTES = 256 * 1024;

type ServiceAccountCredential = VertexServiceAccountPickResult & {
  privateKey: string;
};

type AccessTokenClient = {
  credentials: {
    access_token?: string | null;
    expiry_date?: number | null;
  };
  getAccessToken: () => Promise<{ token?: string | null }>;
};

type CachedClient = {
  signature: string;
  client: AccessTokenClient;
};

export type VertexAccessTokenProvider = (request?: {
  forceRefresh?: boolean;
}) => Promise<string>;

export type VertexServiceAccountAuthDependencies = {
  readFile: typeof readFile;
  stat: typeof stat;
  createClient: (credential: ServiceAccountCredential) => AccessTokenClient;
};

const defaultDependencies: VertexServiceAccountAuthDependencies = {
  readFile,
  stat,
  createClient: (credential) =>
    new JWT({
      email: credential.clientEmail,
      key: credential.privateKey,
      scopes: [CLOUD_PLATFORM_SCOPE],
    }),
};

const clientCache = new Map<string, CachedClient>();

export async function inspectVertexServiceAccountFile(
  filePath: string,
  dependencies: VertexServiceAccountAuthDependencies = defaultDependencies,
): Promise<VertexServiceAccountPickResult> {
  const credential = await readValidatedCredential(filePath, dependencies);
  return toPublicInfo(credential);
}

export function createVertexServiceAccountAccessTokenProvider(
  filePath: string,
  dependencies: VertexServiceAccountAuthDependencies = defaultDependencies,
): VertexAccessTokenProvider {
  const normalizedPath = normalizeCredentialPath(filePath);
  return async (request = {}) => {
    const { client } = await loadClient(normalizedPath, dependencies);
    if (request.forceRefresh) {
      client.credentials.access_token = undefined;
      client.credentials.expiry_date = 0;
    }
    const token = (await client.getAccessToken()).token?.trim();
    if (!token) {
      throw new Error(
        "Vertex 서비스 계정에서 액세스 토큰을 발급받지 못했습니다.",
      );
    }
    return token;
  };
}

export async function getVertexServiceAccountAccessToken(
  filePath: string,
  request: { forceRefresh?: boolean } = {},
): Promise<string> {
  return createVertexServiceAccountAccessTokenProvider(filePath)(request);
}

async function loadClient(
  filePath: string,
  dependencies: VertexServiceAccountAuthDependencies,
): Promise<CachedClient> {
  const fileStat = await readCredentialStat(filePath, dependencies);
  const signature = `${fileStat.size}:${fileStat.mtimeMs}`;
  const cached = clientCache.get(filePath);
  if (cached?.signature === signature) {
    return cached;
  }
  const credential = await readValidatedCredential(
    filePath,
    dependencies,
    fileStat,
  );
  const next = {
    signature,
    client: dependencies.createClient(credential),
  };
  clientCache.set(filePath, next);
  return next;
}

async function readValidatedCredential(
  filePath: string,
  dependencies: VertexServiceAccountAuthDependencies,
  knownStat?: Awaited<ReturnType<typeof stat>>,
): Promise<ServiceAccountCredential> {
  const normalizedPath = normalizeCredentialPath(filePath);
  const fileStat =
    knownStat ?? (await readCredentialStat(normalizedPath, dependencies));
  if (fileStat.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error("Vertex 서비스 계정 JSON 파일이 허용 크기를 초과했습니다.");
  }
  let parsed: unknown;
  try {
    const text = await dependencies.readFile(normalizedPath, "utf8");
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(
      "Vertex 서비스 계정 JSON 파일을 읽거나 해석할 수 없습니다.",
      {
        cause: error,
      },
    );
  }
  return validateCredentialRecord(parsed, normalizedPath);
}

async function readCredentialStat(
  filePath: string,
  dependencies: VertexServiceAccountAuthDependencies,
): Promise<Awaited<ReturnType<typeof stat>>> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await dependencies.stat(filePath);
  } catch (error) {
    throw new Error("선택한 Vertex 서비스 계정 JSON 파일을 찾을 수 없습니다.", {
      cause: error,
    });
  }
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(
      "Vertex 서비스 계정 인증에는 비어 있지 않은 파일이 필요합니다.",
    );
  }
  return fileStat;
}

function normalizeCredentialPath(filePath: string): string {
  const normalized = resolve(String(filePath ?? "").trim());
  if (!filePath.trim() || extname(normalized).toLowerCase() !== ".json") {
    throw new Error("Vertex 서비스 계정 인증에는 JSON 키 파일이 필요합니다.");
  }
  return normalized;
}

function validateCredentialRecord(
  value: unknown,
  filePath: string,
): ServiceAccountCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vertex 인증 파일의 JSON 루트가 올바르지 않습니다.");
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "service_account") {
    throw new Error(
      "서비스 계정 키 JSON이 아닙니다. type 값이 service_account여야 합니다.",
    );
  }
  const projectId = readBoundedString(record.project_id, 100);
  const clientEmail = readBoundedString(record.client_email, 320);
  const privateKey = readBoundedString(record.private_key, 32_768);
  if (!projectId) {
    throw new Error("서비스 계정 JSON에 project_id가 없습니다.");
  }
  if (
    !clientEmail ||
    !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/i.test(clientEmail)
  ) {
    throw new Error("서비스 계정 JSON의 client_email이 올바르지 않습니다.");
  }
  if (
    !privateKey ||
    !/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(
      privateKey,
    )
  ) {
    throw new Error("서비스 계정 JSON의 private_key가 올바르지 않습니다.");
  }
  if (record.token_uri !== GOOGLE_TOKEN_URI) {
    throw new Error("서비스 계정 JSON의 Google 토큰 주소가 올바르지 않습니다.");
  }
  return {
    filePath,
    fileName: basename(filePath),
    projectId,
    clientEmail,
    privateKey,
  };
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function toPublicInfo(
  credential: ServiceAccountCredential,
): VertexServiceAccountPickResult {
  return {
    filePath: credential.filePath,
    fileName: credential.fileName,
    projectId: credential.projectId,
    clientEmail: credential.clientEmail,
  };
}

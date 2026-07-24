import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MAX_BOOTSTRAP_LOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETAINED_BOOTSTRAP_LOG_BYTES = 256 * 1024;

type BootstrapLoggerOptions = {
  resolveLogPath: () => string;
  maxBytes?: number;
  retainedBytes?: number;
  now?: () => Date;
};

export function createBootstrapLogger(options: BootstrapLoggerOptions): {
  write: (message: string, detail?: unknown) => void;
} {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BOOTSTRAP_LOG_BYTES;
  const retainedBytes =
    options.retainedBytes ?? DEFAULT_RETAINED_BOOTSTRAP_LOG_BYTES;
  const now = options.now ?? (() => new Date());
  let preparedLogPath: string | null = null;

  return {
    write(message, detail) {
      try {
        const logPath = options.resolveLogPath();
        if (preparedLogPath !== logPath) {
          prepareBootstrapLog(logPath, maxBytes, retainedBytes, now);
          preparedLogPath = logPath;
        }
        const suffix =
          detail === undefined ? "" : ` ${serializeBootstrapDetail(detail)}`;
        appendFileSync(
          logPath,
          `[${now().toISOString()}] ${message}${suffix}\n`,
          "utf8",
        );
      } catch (_error) {
        // error-policy-allow: bootstrap logging must never block app startup.
        preparedLogPath = null;
      }
    },
  };
}

function prepareBootstrapLog(
  logPath: string,
  maxBytes: number,
  retainedBytes: number,
  now: () => Date,
): void {
  mkdirSync(dirname(logPath), { recursive: true });
  if (!existsSync(logPath) || statSync(logPath).size <= maxBytes) {
    return;
  }
  try {
    const tail = readFileTail(logPath, retainedBytes);
    const previousPath = join(dirname(logPath), "bootstrap.previous.log");
    const rotationNote = `# ${now().toISOString()} retained tail from oversized bootstrap.log\n`;
    writeFileSync(
      previousPath,
      Buffer.concat([Buffer.from(rotationNote), tail]),
    );
    writeFileSync(
      logPath,
      `# ${now().toISOString()} oversized bootstrap.log rotated; recent tail saved to bootstrap.previous.log\n`,
      "utf8",
    );
  } catch (_error) {
    // error-policy-allow: keep the original bootstrap log intact when bounded rotation fails.
  }
}

function readFileTail(filePath: string, retainedBytes: number): Buffer {
  const size = statSync(filePath).size;
  const byteCount = Math.min(Math.max(retainedBytes, 0), size);
  const buffer = Buffer.alloc(byteCount);
  if (byteCount === 0) {
    return buffer;
  }
  const descriptor = openSync(filePath, "r");
  try {
    readSync(descriptor, buffer, 0, byteCount, size - byteCount);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function serializeBootstrapDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return JSON.stringify({
      name: detail.name,
      message: detail.message,
      stack: detail.stack,
    });
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch (_error) {
    return String(detail);
  }
}

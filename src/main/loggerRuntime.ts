import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { rotateLogFile } from "./logRotation";

const UTF8_BOM = "\ufeff";
const UTF8_BOM_BYTES = Buffer.from(UTF8_BOM, "utf8");
const DEFAULT_MAX_ROTATED_LOG_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETAINED_LOG_BYTES = 2 * 1024 * 1024;

type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export type LogOutputStream = {
  write(
    chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean | void;
  on(event: "error", listener: (error: unknown) => void): unknown;
};

type LoggerRuntimeOptions = {
  resolveLogPath: () => string;
  serializeDetail: (detail: unknown) => string;
  stdout?: LogOutputStream;
  stderr?: LogOutputStream;
  now?: () => Date;
  maxRotatedLogBytes?: number;
  retainedLogBytes?: number;
};

type LoggerRuntime = {
  resetAppLog: () => void;
  writeLog: (level: RuntimeLogLevel, message: string, detail?: unknown) => void;
};

type ConsoleDestinationName = "stdout" | "stderr";

type ConsoleDestination = {
  disabled: boolean;
  errorSubscription: StreamErrorSubscriber | null;
  name: ConsoleDestinationName;
  stream: LogOutputStream;
};

type ConsoleTransportFailure = {
  destination: ConsoleDestinationName;
  error: Error;
};

type StreamErrorSubscriber = {
  notify: (error: unknown) => void;
};

type SharedStreamErrorBoundary = {
  subscribers: Set<WeakRef<StreamErrorSubscriber>>;
};

type SharedStreamErrorRegistry = {
  boundaries: WeakMap<LogOutputStream, SharedStreamErrorBoundary>;
};

declare global {
  var __carrotMangaLoggerStreamErrorsV1: SharedStreamErrorRegistry | undefined;
}

export function createLoggerRuntime(
  options: LoggerRuntimeOptions,
): LoggerRuntime {
  const now = options.now ?? (() => new Date());
  const destination = new LogFileDestination();
  const formatLogLine = (
    level: RuntimeLogLevel,
    message: string,
    detail?: unknown,
  ): string => {
    const suffix =
      detail === undefined ? "" : ` ${options.serializeDetail(detail)}`;
    return `[${now().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}\n`;
  };
  const consoleTransport = createConsoleTransport(
    options.stdout ?? process.stdout,
    options.stderr ?? process.stderr,
    (failure) =>
      recordConsoleTransportFailure(
        failure,
        options.resolveLogPath,
        destination,
        formatLogLine,
      ),
  );

  return {
    resetAppLog: () =>
      resetRuntimeLog(
        options.resolveLogPath(),
        destination,
        consoleTransport,
        formatLogLine,
        options.maxRotatedLogBytes ?? DEFAULT_MAX_ROTATED_LOG_BYTES,
        options.retainedLogBytes ?? DEFAULT_RETAINED_LOG_BYTES,
      ),
    writeLog: (level, message, detail) =>
      writeRuntimeLog(
        level,
        message,
        detail,
        options.resolveLogPath(),
        destination,
        consoleTransport,
        formatLogLine,
      ),
  };
}

type LogLineFormatter = (
  level: RuntimeLogLevel,
  message: string,
  detail?: unknown,
) => string;

type ConsoleTransport = ReturnType<typeof createConsoleTransport>;

function writeRuntimeLog(
  level: RuntimeLogLevel,
  message: string,
  detail: unknown,
  logPath: string,
  destination: LogFileDestination,
  consoleTransport: ConsoleTransport,
  formatLogLine: LogLineFormatter,
): void {
  const line = formatLogLine(level, message, detail);
  consoleTransport.write(level, line.trimEnd());
  try {
    destination.append(logPath, line);
  } catch (error) {
    destination.invalidate();
    consoleTransport.write(
      "error",
      formatLogLine("error", "Failed to write app log", error).trimEnd(),
    );
  }
}

function resetRuntimeLog(
  logPath: string,
  destination: LogFileDestination,
  consoleTransport: ConsoleTransport,
  formatLogLine: LogLineFormatter,
  maxRotatedLogBytes: number,
  retainedLogBytes: number,
): void {
  try {
    destination.ensureDirectory(logPath);
    if (
      !rotateCurrentLog(
        logPath,
        consoleTransport,
        formatLogLine,
        maxRotatedLogBytes,
        retainedLogBytes,
      )
    ) {
      destination.invalidate();
      return;
    }
    writeFileSync(logPath, "", "utf8");
    destination.invalidateLogPath();
  } catch (error) {
    destination.invalidate();
    consoleTransport.write(
      "error",
      formatLogLine("error", "Failed to reset app log", error).trimEnd(),
    );
  }
}

function recordConsoleTransportFailure(
  failure: ConsoleTransportFailure,
  resolveLogPath: () => string,
  destination: LogFileDestination,
  formatLogLine: LogLineFormatter,
): void {
  const line = formatLogLine(
    "warn",
    `Console log transport disabled (${failure.destination})`,
    failure.error,
  );
  try {
    destination.append(resolveLogPath(), line);
  } catch (_error) {
    // Both diagnostic destinations failed. Do not recurse through either one.
    destination.invalidate();
  }
}

function rotateCurrentLog(
  logPath: string,
  consoleTransport: ConsoleTransport,
  formatLogLine: LogLineFormatter,
  maxRotatedLogBytes: number,
  retainedLogBytes: number,
): boolean {
  try {
    rotateLogFile(logPath, maxRotatedLogBytes, retainedLogBytes);
    return true;
  } catch (error) {
    consoleTransport.write(
      "error",
      formatLogLine(
        "error",
        "Failed to rotate app log; preserving current log",
        error,
      ).trimEnd(),
    );
    return false;
  }
}

class LogFileDestination {
  private preparedDirectory: string | null = null;
  private preparedLogPath: string | null = null;

  append(logPath: string, line: string): void {
    this.prepareLogFile(logPath);
    appendFileSync(logPath, line, "utf8");
  }

  ensureDirectory(logPath: string): void {
    const directory = dirname(logPath);
    if (this.preparedDirectory === directory) {
      return;
    }
    mkdirSync(directory, { recursive: true });
    this.preparedDirectory = directory;
  }

  invalidate(): void {
    this.preparedDirectory = null;
    this.preparedLogPath = null;
  }

  invalidateLogPath(): void {
    this.preparedLogPath = null;
  }

  private prepareLogFile(logPath: string): void {
    this.ensureDirectory(logPath);
    if (this.preparedLogPath === logPath) {
      return;
    }
    ensureUtf8Bom(logPath);
    this.preparedLogPath = logPath;
  }
}

function createConsoleTransport(
  stdout: LogOutputStream,
  stderr: LogOutputStream,
  onFailure: (failure: ConsoleTransportFailure) => void,
): {
  write: (level: RuntimeLogLevel, line: string) => void;
} {
  const destinations: Record<ConsoleDestinationName, ConsoleDestination> = {
    stdout: {
      disabled: false,
      errorSubscription: null,
      name: "stdout",
      stream: stdout,
    },
    stderr: {
      disabled: false,
      errorSubscription: null,
      name: "stderr",
      stream: stderr,
    },
  };
  bindStreamError(destinations.stdout, onFailure);
  bindStreamError(destinations.stderr, onFailure);

  return {
    write(level, line) {
      const destination =
        level === "error" || level === "warn"
          ? destinations.stderr
          : destinations.stdout;
      writeToDestination(destination, `${line}\n`, onFailure);
    },
  };
}

function bindStreamError(
  destination: ConsoleDestination,
  onFailure: (failure: ConsoleTransportFailure) => void,
): void {
  const subscriber: StreamErrorSubscriber = {
    notify: (error) => {
      disableDestination(destination, error, onFailure);
    },
  };
  try {
    subscribeToStreamErrors(destination.stream, subscriber);
    destination.errorSubscription = subscriber;
  } catch (error) {
    disableDestination(destination, error, onFailure);
  }
}

function subscribeToStreamErrors(
  stream: LogOutputStream,
  subscriber: StreamErrorSubscriber,
): void {
  const registry = getSharedStreamErrorRegistry();
  const existingBoundary = registry.boundaries.get(stream);
  if (existingBoundary) {
    pruneExpiredSubscribers(existingBoundary);
    existingBoundary.subscribers.add(new WeakRef(subscriber));
    return;
  }

  const boundary: SharedStreamErrorBoundary = {
    subscribers: new Set([new WeakRef(subscriber)]),
  };
  stream.on("error", (error) => {
    notifyStreamErrorSubscribers(boundary, error);
  });
  registry.boundaries.set(stream, boundary);
}

function getSharedStreamErrorRegistry(): SharedStreamErrorRegistry {
  globalThis.__carrotMangaLoggerStreamErrorsV1 ??= {
    boundaries: new WeakMap(),
  };
  return globalThis.__carrotMangaLoggerStreamErrorsV1;
}

function notifyStreamErrorSubscribers(
  boundary: SharedStreamErrorBoundary,
  error: unknown,
): void {
  for (const reference of boundary.subscribers) {
    const subscriber = reference.deref();
    if (subscriber) {
      subscriber.notify(error);
    } else {
      boundary.subscribers.delete(reference);
    }
  }
}

function pruneExpiredSubscribers(boundary: SharedStreamErrorBoundary): void {
  for (const reference of boundary.subscribers) {
    if (!reference.deref()) {
      boundary.subscribers.delete(reference);
    }
  }
}

function writeToDestination(
  destination: ConsoleDestination,
  line: string,
  onFailure: (failure: ConsoleTransportFailure) => void,
): void {
  if (destination.disabled) {
    return;
  }
  try {
    destination.stream.write(line, (error) => {
      if (error) {
        disableDestination(destination, error, onFailure);
      }
    });
  } catch (error) {
    disableDestination(destination, error, onFailure);
  }
}

function disableDestination(
  destination: ConsoleDestination,
  error: unknown,
  onFailure: (failure: ConsoleTransportFailure) => void,
): void {
  if (destination.disabled) {
    return;
  }
  destination.disabled = true;
  onFailure({
    destination: destination.name,
    error: normalizeError(error),
  });
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function ensureUtf8Bom(logPath: string): void {
  if (!existsSync(logPath)) {
    writeFileSync(logPath, UTF8_BOM, "utf8");
    return;
  }
  if (statSync(logPath).size === 0) {
    writeFileSync(logPath, UTF8_BOM, "utf8");
    return;
  }
  if (fileStartsWithUtf8Bom(logPath)) {
    return;
  }
  const content = readFileSync(logPath);
  writeFileSync(logPath, Buffer.concat([UTF8_BOM_BYTES, content]));
}

function fileStartsWithUtf8Bom(logPath: string): boolean {
  const descriptor = openSync(logPath, "r");
  try {
    const prefix = Buffer.allocUnsafe(UTF8_BOM_BYTES.length);
    const bytesRead = readSync(descriptor, prefix, 0, UTF8_BOM_BYTES.length, 0);
    return bytesRead === UTF8_BOM_BYTES.length && prefix.equals(UTF8_BOM_BYTES);
  } finally {
    closeSync(descriptor);
  }
}

import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function rotateLogFile(
  logPath: string,
  maxRotatedBytes: number,
  retainedBytes: number,
): void {
  if (!existsSync(logPath)) {
    return;
  }
  const size = statSync(logPath).size;
  if (size === 0) {
    return;
  }
  const previousPath = join(dirname(logPath), "previous.log");
  if (size <= maxRotatedBytes) {
    copyFileSync(logPath, previousPath);
    return;
  }
  const tail = readFileTail(logPath, retainedBytes, size);
  writeFileSync(
    previousPath,
    Buffer.concat([
      Buffer.from(
        `# retained ${tail.length} byte tail from oversized app.log\n`,
      ),
      tail,
    ]),
  );
}

function readFileTail(
  filePath: string,
  retainedBytes: number,
  fileSize: number,
): Buffer {
  const byteCount = Math.min(Math.max(retainedBytes, 0), fileSize);
  const buffer = Buffer.alloc(byteCount);
  if (byteCount === 0) {
    return buffer;
  }
  const descriptor = openSync(filePath, "r");
  try {
    readSync(
      descriptor,
      buffer,
      0,
      byteCount,
      Math.max(fileSize - byteCount, 0),
    );
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

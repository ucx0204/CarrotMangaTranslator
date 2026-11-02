import type { LibraryIndex } from "../../../shared/libraryTypes";

/** Coalesce metadata notifications without publishing an already superseded read. */
export function createLibraryRefreshCoordinator(port: {
  read: () => Promise<LibraryIndex>;
  publish: (library: LibraryIndex) => void;
  reportError: (error: unknown) => void;
}) {
  let running = false;
  let pending = false;
  let disposed = false;
  const refresh = async () => {
    running = true;
    do {
      pending = false;
      try {
        const library = await port.read();
        if (!disposed && !pending) port.publish(library);
      } catch (error) {
        if (!disposed) port.reportError(error);
      }
    } while (!disposed && pending);
    running = false;
  };
  return {
    request: () => {
      if (disposed) return;
      pending = true;
      if (!running) void refresh();
    },
    dispose: () => {
      disposed = true;
    },
  };
}

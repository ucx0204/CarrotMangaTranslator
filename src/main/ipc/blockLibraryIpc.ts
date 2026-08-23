import { blockLibraryIpcContracts } from "../../shared/ipcContracts";
import { BlockLibraryStore } from "../blockLibraryStore";
import type { IpcContext } from "./context";
import { registeredRendererHandleContract } from "./trustedIpc";

export function registerBlockLibraryIpc(context: IpcContext): void {
  const store = new BlockLibraryStore(context.appPaths.dataRoot);
  registeredRendererHandleContract(
    context,
    blockLibraryIpcContracts.listBlockLibraryEntries,
    () => store.list(),
  );
  registeredRendererHandleContract(
    context,
    blockLibraryIpcContracts.saveBlockLibraryEntry,
    (_event, input) => store.save(input),
  );
  registeredRendererHandleContract(
    context,
    blockLibraryIpcContracts.renameBlockLibraryEntry,
    (_event, input) => store.rename(input),
  );
  registeredRendererHandleContract(
    context,
    blockLibraryIpcContracts.updateBlockLibraryEntry,
    (_event, input) => store.update(input),
  );
  registeredRendererHandleContract(
    context,
    blockLibraryIpcContracts.deleteBlockLibraryEntry,
    (_event, id) => store.delete(id),
  );
  registeredRendererHandleContract(
    context,
    blockLibraryIpcContracts.useBlockLibraryEntry,
    (_event, id) => store.use(id),
  );
}

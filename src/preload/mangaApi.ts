import type { MangaApi } from "../shared/mangaApi";
import {
  ipcEventContracts,
  ipcInvokeContracts,
  type IpcContract,
  type IpcEventContract,
} from "../shared/ipcContracts";
import type { ContractInvoker } from "./ipcContracts";

type IpcEventListener = (event: unknown, payload: unknown) => void;

export type IpcEventPort = {
  on: (channel: string, listener: IpcEventListener) => void;
  removeListener: (channel: string, listener: IpcEventListener) => void;
};

export type MangaApiRuntime = {
  invoke: ContractInvoker;
  events: IpcEventPort;
  warn: (message: string) => void;
};

type ContractArgs<TContract> =
  TContract extends IpcContract<infer TArgs, unknown> ? TArgs : never;

type ContractResult<TContract> =
  TContract extends IpcContract<unknown[], infer TResult> ? TResult : never;

type InvokeContractApi<TContracts extends Record<string, IpcContract>> = {
  [TKey in keyof TContracts]: (
    ...args: ContractArgs<TContracts[TKey]>
  ) => Promise<ContractResult<TContracts[TKey]>>;
};

export function createMangaApi(runtime: MangaApiRuntime): MangaApi {
  const invokeApi = bindInvokeContracts(ipcInvokeContracts, runtime.invoke);
  return {
    ...invokeApi,
    onPanelState: (callback) =>
      subscribeToIpcEvent(ipcEventContracts.panelState, callback, runtime),
    onPanelCommand: (callback) =>
      subscribeToIpcEvent(ipcEventContracts.panelCommand, callback, runtime),
    onPanelWindowsChanged: (callback) =>
      subscribeToIpcEvent(
        ipcEventContracts.panelWindowsChanged,
        callback,
        runtime,
      ),
    onErrorIncident: (callback) =>
      subscribeToIpcEvent(ipcEventContracts.errorIncident, callback, runtime),
    onJobEvent: (callback) =>
      subscribeToIpcEvent(ipcEventContracts.jobEvent, callback, runtime),
    onModelTestEvent: (callback) =>
      subscribeToIpcEvent(
        ipcEventContracts.modelTestProgress,
        callback,
        runtime,
      ),
    onUiLocaleChanged: (callback) =>
      subscribeToIpcEvent(ipcEventContracts.uiLocaleChanged, callback, runtime),
    onFontLibraryChanged: (callback) =>
      subscribeToIpcEvent(
        ipcEventContracts.fontLibraryChanged,
        callback,
        runtime,
      ),
  };
}

function bindInvokeContracts<TContracts extends Record<string, IpcContract>>(
  contracts: TContracts,
  invoke: ContractInvoker,
): InvokeContractApi<TContracts> {
  const entries = Object.entries(contracts).map(([apiKey, contract]) => [
    apiKey,
    (...args: unknown[]) => invoke(contract, ...args),
  ]);
  return Object.fromEntries(entries) as InvokeContractApi<TContracts>;
}

function subscribeToIpcEvent<TPayload>(
  contract: IpcEventContract<TPayload>,
  callback: (payload: TPayload) => void,
  runtime: Pick<MangaApiRuntime, "events" | "warn">,
): () => void {
  const listener: IpcEventListener = (_event, payload) => {
    const result = contract.payload.safeParse(payload);
    if (result.success) {
      callback(result.data as TPayload);
      return;
    }
    runtime.warn(`Invalid ${contract.eventKey} payload ignored`);
  };
  runtime.events.on(contract.channel, listener);
  return () => {
    runtime.events.removeListener(contract.channel, listener);
  };
}

import { ipcRenderer } from "electron";
import type { IpcContract } from "../shared/ipcContracts";

export function invokeContract<TArgs extends unknown[], TResult>(
  contract: IpcContract<TArgs, TResult>,
  ...args: TArgs
): Promise<TResult> {
  contract.args.parse(args);
  return ipcRenderer.invoke(contract.channel, ...args) as Promise<TResult>;
}

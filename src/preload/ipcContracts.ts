import type { IpcContract } from "../shared/ipcContracts";

export type IpcInvokePort = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

export type ContractInvoker = <TArgs extends unknown[], TResult>(
  contract: IpcContract<TArgs, TResult>,
  ...args: TArgs
) => Promise<TResult>;

export function createContractInvoker(port: IpcInvokePort): ContractInvoker {
  return <TArgs extends unknown[], TResult>(
    contract: IpcContract<TArgs, TResult>,
    ...args: TArgs
  ): Promise<TResult> => {
    const parsedArgs = contract.args.parse(args) as TArgs;
    return port.invoke(contract.channel, ...parsedArgs) as Promise<TResult>;
  };
}

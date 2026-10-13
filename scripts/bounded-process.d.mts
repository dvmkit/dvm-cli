export type ProcessResult = {
  error?: Error;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string | null;
  stdout?: string | null;
};

/** Run one owned process group and kill the wrapper plus descendants on timeout. */
export function runBoundedProcess(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<ProcessResult>;

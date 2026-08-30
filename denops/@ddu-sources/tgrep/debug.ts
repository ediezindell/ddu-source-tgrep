import type { Denops } from "@denops/std";

export type DebugLogger = (message: string) => Promise<void>;

export function vimStringLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export function createDebugLogger(
  denops: Denops,
  enabled: boolean,
): DebugLogger {
  if (!enabled) {
    return () => Promise.resolve();
  }

  return async (message: string) => {
    const oneLine = message.replaceAll(/\r?\n/g, " ");
    await denops.cmd(
      `echomsg ${vimStringLiteral(`[ddu-source-tgrep] ${oneLine}`)}`,
    );
  };
}

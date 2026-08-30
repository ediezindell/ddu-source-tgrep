import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import { pathExists, resolveRootFrom } from "../@ddu-sources/tgrep/root.ts";
import { stopServer } from "../@ddu-sources/tgrep/server.ts";

export function main(denops: Denops): void {
  denops.dispatcher = {
    async stop(path: unknown): Promise<string> {
      if (typeof path !== "string") {
        throw new TypeError(
          `ddu-tgrep: "stop" expects a string path, got ${typeof path}`,
        );
      }

      const root = resolveRootFrom({
        sourcePath: path,
        cwd: await fn.getcwd(denops) as string,
        exists: pathExists,
      });
      const info = await stopServer(root);
      return `ddu-source-tgrep: sent SIGTERM to the tgrep server (root=${root}, pid=${info.pid})`;
    },
  };
}

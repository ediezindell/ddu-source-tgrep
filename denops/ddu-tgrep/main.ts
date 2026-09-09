import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import { listHiddenIndexPaths } from "../@ddu-sources/tgrep/hidden.ts";
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

      const main = await stopServer(root);
      const stopped = [main.pid];
      for (const indexPath of await listHiddenIndexPaths(root)) {
        try {
          const info = await stopServer(root, indexPath);
          stopped.push(info.pid);
        } catch {
          // No hidden server has been started for this index yet.
        }
      }

      return `ddu-source-tgrep: sent SIGTERM to the tgrep server(s) (root=${root}, pids=${
        stopped.join(",")
      })`;
    },
  };
}

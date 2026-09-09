import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import { join } from "@std/path/join";
import { cacheBaseDir } from "../@ddu-sources/tgrep/cache.ts";
import { parseGitignore } from "../@ddu-sources/tgrep/gitignore.ts";
import {
  findHiddenDirs,
  hiddenIndexPath,
} from "../@ddu-sources/tgrep/hidden.ts";
import { pathExists, resolveRootFrom } from "../@ddu-sources/tgrep/root.ts";
import { stopServer } from "../@ddu-sources/tgrep/server.ts";

async function listHiddenIndexPaths(root: string): Promise<string[]> {
  const entries: { name: string; isDirectory: boolean }[] = [];
  for await (const entry of Deno.readDir(root)) {
    entries.push({ name: entry.name, isDirectory: entry.isDirectory });
  }
  let gitignore = "";
  try {
    gitignore = await Deno.readTextFile(join(root, ".gitignore"));
  } catch (e: unknown) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }
  const isIgnored = parseGitignore(gitignore);
  return findHiddenDirs({ entries, isIgnored })
    .map((dir) => hiddenIndexPath({ cacheBase: cacheBaseDir(), root, dir }));
}

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

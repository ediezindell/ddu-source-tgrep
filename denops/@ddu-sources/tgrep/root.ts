import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";

export function pathExists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      return false;
    }
    throw e;
  }
}

export function findGitRoot(
  startDir: string,
  exists: (path: string) => boolean,
): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (exists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function resolveRootFrom(args: {
  sourcePath: string;
  cwd: string;
  exists: (path: string) => boolean;
}): string {
  if (args.sourcePath.length !== 0) {
    return resolve(args.sourcePath);
  }
  return findGitRoot(args.cwd, args.exists) ?? resolve(args.cwd);
}

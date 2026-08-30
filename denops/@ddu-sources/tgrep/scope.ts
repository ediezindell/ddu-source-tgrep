import { SEPARATOR } from "@std/path/constants";
import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { relative } from "@std/path/relative";
import { resolve } from "@std/path/resolve";

export type Scope = "all" | "cwd" | "marker";

export class ScopeError extends Error {
  override name = "ScopeError";
}

export function scopeRelativeDir(root: string, dir: string): string {
  const rel = relative(resolve(root), resolve(dir));
  if (rel.length === 0) {
    return "";
  }
  if (rel === ".." || rel.startsWith(`..${SEPARATOR}`)) {
    throw new ScopeError(
      `tgrep: "${dir}" is outside of the server root "${root}"`,
    );
  }
  return rel.replaceAll(SEPARATOR, "/");
}

export function findMarkerDir(args: {
  cwd: string;
  root: string;
  markers: string[];
  exists: (path: string) => boolean;
}): string | undefined {
  const root = resolve(args.root);
  let dir = resolve(args.cwd);
  for (;;) {
    if (args.markers.some((marker) => args.exists(join(dir, marker)))) {
      return dir;
    }
    if (dir === root) {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function resolveScope(args: {
  scope: Scope;
  root: string;
  cwd: string;
  markers: string[];
  exists: (path: string) => boolean;
}): string {
  switch (args.scope) {
    case "all":
      return "";
    case "cwd":
      return scopeRelativeDir(args.root, args.cwd);
    case "marker": {
      const dir = findMarkerDir({
        cwd: args.cwd,
        root: args.root,
        markers: args.markers,
        exists: args.exists,
      });
      if (dir === undefined) {
        throw new ScopeError(
          `tgrep: no root marker (${
            args.markers.join(", ")
          }) found between "${args.cwd}" and "${args.root}"`,
        );
      }
      return scopeRelativeDir(args.root, dir);
    }
    default:
      throw new ScopeError(`tgrep: unknown scope: ${String(args.scope)}`);
  }
}

export function combineGlobs(prefix: string, globs: string[]): string[] {
  if (prefix.length === 0) {
    return [...globs];
  }

  const includes = globs.filter((glob) => !glob.startsWith("!"));
  const excludes = globs.filter((glob) => glob.startsWith("!"));
  if (includes.length === 0) {
    return [`${prefix}/**`, ...excludes];
  }
  return [
    ...includes.map((glob) => `${prefix}/**/${glob}`),
    ...excludes,
  ];
}

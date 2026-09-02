import { join } from "@std/path/join";

const ALWAYS_EXCLUDED = new Set([".git", ".tgrep"]);

export function encodeRootDir(root: string): string {
  return encodeURIComponent(root);
}

export function decodeRootDir(name: string): string {
  return decodeURIComponent(name);
}

export function hiddenIndexPath(args: {
  cacheBase: string;
  root: string;
  dir: string;
}): string {
  return join(
    args.cacheBase,
    encodeRootDir(args.root),
    args.dir,
  );
}

export function findHiddenDirs(args: {
  entries: { name: string; isDirectory: boolean }[];
  isIgnored: (name: string) => boolean;
}): string[] {
  return args.entries
    .filter((entry) =>
      entry.isDirectory &&
      entry.name.startsWith(".") &&
      !ALWAYS_EXCLUDED.has(entry.name) &&
      !args.isIgnored(entry.name)
    )
    .map((entry) => entry.name);
}

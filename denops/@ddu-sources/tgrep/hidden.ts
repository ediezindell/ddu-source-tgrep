import { join } from "@std/path/join";
import { cacheBaseDir } from "./cache.ts";
import { parseGitignore } from "./gitignore.ts";

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

export type DirEntry = { name: string; isDirectory: boolean };

export async function listHiddenDirs(args: {
  root: string;
  listEntries?: (root: string) => Promise<DirEntry[]>;
  readGitignore?: (root: string) => Promise<string>;
}): Promise<string[]> {
  const listEntries = args.listEntries ?? (async (root: string) => {
    const entries: DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(root)) {
        entries.push({ name: entry.name, isDirectory: entry.isDirectory });
      }
    } catch {
      return [];
    }
    return entries;
  });

  const readGitignore = args.readGitignore ?? (async (root: string) => {
    try {
      return await Deno.readTextFile(join(root, ".gitignore"));
    } catch (e: unknown) {
      if (e instanceof Deno.errors.NotFound) {
        return "";
      }
      throw e;
    }
  });

  const entries = await listEntries(args.root);
  const gitignore = await readGitignore(args.root);
  const isIgnored = parseGitignore(gitignore);
  return findHiddenDirs({ entries, isIgnored });
}

export async function listHiddenIndexPaths(root: string): Promise<string[]> {
  const dirs = await listHiddenDirs({ root });
  const cacheBase = cacheBaseDir();
  return dirs.map((dir) => hiddenIndexPath({ cacheBase, root, dir }));
}

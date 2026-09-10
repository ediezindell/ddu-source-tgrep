import { join } from "@std/path/join";
import { globToRegExp } from "@std/path/glob-to-regexp";

export async function readRootGitignore(root: string): Promise<string> {
  try {
    return await Deno.readTextFile(join(root, ".gitignore"));
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      return "";
    }
    throw e;
  }
}

export function parseGitignore(text: string): (name: string) => boolean {
  const matchers: ((name: string) => boolean)[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    const clean = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean.length === 0) {
      continue;
    }
    try {
      const rx = globToRegExp(clean, { globstar: true, extended: true });
      matchers.push((name) => rx.test(name) || name === clean);
    } catch {
      matchers.push((name) => name === clean);
    }
  }
  return (name: string) => matchers.some((match) => match(name));
}

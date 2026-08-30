import { assertEquals } from "@std/assert";
import { join } from "@std/path/join";
import { findGitRoot, pathExists, resolveRootFrom } from "./root.ts";

function existsIn(paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

Deno.test("findGitRoot は .git を持つ最初の上位ディレクトリを返す", () => {
  const repo = join("/tmp", "repo");
  const deep = join(repo, "src", "nested");

  assertEquals(findGitRoot(deep, existsIn([join(repo, ".git")])), repo);
});

Deno.test("findGitRoot は .git がファイルでも見つける", () => {
  const repo = join("/tmp", "worktree");

  assertEquals(findGitRoot(repo, existsIn([join(repo, ".git")])), repo);
});

Deno.test("findGitRoot は見つからなければ undefined", () => {
  assertEquals(findGitRoot(join("/tmp", "loose"), existsIn([])), undefined);
});

Deno.test("resolveRootFrom は sourcePath があればそれを使う", () => {
  assertEquals(
    resolveRootFrom({
      sourcePath: join("/tmp", "given"),
      cwd: join("/tmp", "repo", "src"),
      exists: existsIn([join("/tmp", "repo", ".git")]),
    }),
    join("/tmp", "given"),
  );
});

Deno.test("resolveRootFrom は sourcePath が空なら git root を使う", () => {
  const repo = join("/tmp", "repo");

  assertEquals(
    resolveRootFrom({
      sourcePath: "",
      cwd: join(repo, "src"),
      exists: existsIn([join(repo, ".git")]),
    }),
    repo,
  );
});

Deno.test("resolveRootFrom は git root が無ければ cwd を使う", () => {
  const cwd = join("/tmp", "loose", "dir");

  assertEquals(
    resolveRootFrom({ sourcePath: "", cwd, exists: existsIn([]) }),
    cwd,
  );
});

Deno.test("pathExists は実在するディレクトリに true、しないパスに false", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ddu-tgrep-" });
  try {
    assertEquals(pathExists(dir), true);
    assertEquals(pathExists(join(dir, "absent")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

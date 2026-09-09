import { assertEquals } from "@std/assert";
import { parseGitignore } from "./gitignore.ts";

function matcher(text: string): (name: string) => boolean {
  return parseGitignore(text);
}

Deno.test("parseGitignore は空文字なら何も無視しない", () => {
  assertEquals(matcher("")(".github"), false);
  assertEquals(matcher("")(".venv"), false);
});

Deno.test("parseGitignore は行ごとのエントリをディレクトリ名と照合する", () => {
  const isIgnored = matcher(".venv\nnode_modules\n.claude");
  assertEquals(isIgnored(".venv"), true);
  assertEquals(isIgnored("node_modules"), true);
  assertEquals(isIgnored(".claude"), true);
  assertEquals(isIgnored(".github"), false);
});

Deno.test("parseGitignore は空行とコメントを飛ばす", () => {
  const isIgnored = matcher("\n# comment\n\n.venv\n");
  assertEquals(isIgnored(".venv"), true);
  assertEquals(isIgnored("# comment"), false);
  assertEquals(isIgnored(""), false);
});

Deno.test("parseGitignore は先頭と末尾のスラッシュを正規化して照合する", () => {
  const isIgnored = matcher("/.venv/\n");
  assertEquals(isIgnored(".venv"), true);
});

Deno.test("parseGitignore は否定パターンを現段階では無視する", () => {
  const isIgnored = matcher("important.log\n!important.log");
  assertEquals(isIgnored("important.log"), true);
});

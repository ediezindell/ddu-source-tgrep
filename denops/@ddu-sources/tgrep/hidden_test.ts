import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeRootDir,
  encodeRootDir,
  findHiddenDirs,
  hiddenIndexPath,
} from "./hidden.ts";

function dir(name: string): { name: string; isDirectory: boolean } {
  return { name, isDirectory: true };
}

Deno.test("findHiddenDirs はドットで始まるディレクトリを返す", () => {
  const entries = [dir(".github"), dir("src")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, [".github"]);
});

Deno.test("findHiddenDirs は見つけたディレクトリの名前をそのまま返す", () => {
  const entries = [dir(".claude"), dir("src")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, [".claude"]);
});

Deno.test("findHiddenDirs は .git を検索対象にしない", () => {
  const entries = [dir(".git"), dir(".github")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, [".github"]);
});

Deno.test("findHiddenDirs は tgrep 自身の索引ディレクトリを検索対象にしない", () => {
  const entries = [dir(".tgrep"), dir(".github")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, [".github"]);
});

Deno.test("findHiddenDirs は gitignore されたディレクトリを検索対象にしない", () => {
  const entries = [dir(".venv"), dir(".github")];

  const found = findHiddenDirs({
    entries,
    isIgnored: (name) => name === ".venv",
  });

  assertEquals(found, [".github"]);
});

Deno.test("findHiddenDirs はドットで始まるファイルを検索対象にしない", () => {
  const entries = [{ name: ".gitignore", isDirectory: false }, dir(".github")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, [".github"]);
});

Deno.test("hiddenIndexPath は索引をキャッシュ配下のリポジトリ別の場所に置く", () => {
  const path = hiddenIndexPath({
    cacheBase: "/home/user/.cache/nvim/ddu-source-tgrep",
    root: "/home/user/repo",
    dir: ".github",
  });

  assertEquals(
    path,
    "/home/user/.cache/nvim/ddu-source-tgrep/%2Fhome%2Fuser%2Frepo/.github",
  );
});

Deno.test("hiddenIndexPath はリポジトリごとに別の索引を指す", () => {
  const path = hiddenIndexPath({
    cacheBase: "/home/user/.cache/nvim/ddu-source-tgrep",
    root: "/home/user/other",
    dir: ".github",
  });

  assertEquals(
    path,
    "/home/user/.cache/nvim/ddu-source-tgrep/%2Fhome%2Fuser%2Fother/.github",
  );
});

Deno.test("hiddenIndexPath は指定されたキャッシュ置き場の下に索引を置く", () => {
  const path = hiddenIndexPath({
    cacheBase: "/home/user/.cache/vim/ddu-source-tgrep",
    root: "/home/user/repo",
    dir: ".github",
  });

  assertEquals(
    path,
    "/home/user/.cache/vim/ddu-source-tgrep/%2Fhome%2Fuser%2Frepo/.github",
  );
});

Deno.test("hiddenIndexPath は hidden ディレクトリごとに別の索引を指す", () => {
  const path = hiddenIndexPath({
    cacheBase: "/home/user/.cache/nvim/ddu-source-tgrep",
    root: "/home/user/repo",
    dir: ".claude",
  });

  assertEquals(
    path,
    "/home/user/.cache/nvim/ddu-source-tgrep/%2Fhome%2Fuser%2Frepo/.claude",
  );
});

Deno.test("エンコードしたキャッシュ名から元のリポジトリの場所に戻せる", () => {
  const root = "/home/user/repos/my project/日本語 100%";

  const restored = decodeRootDir(encodeRootDir(root));

  assertEquals(restored, root);
});

Deno.test("壊れたキャッシュ名は黙って受け入れずエラーにする", () => {
  assertThrows(() => decodeRootDir("%ZZ"));
});

Deno.test("findHiddenDirs は hidden ディレクトリを渡された順序で全件返す", () => {
  const entries = [dir(".github"), dir("src"), dir(".claude"), dir(".vscode")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, [".github", ".claude", ".vscode"]);
});

Deno.test("findHiddenDirs は hidden ディレクトリが無ければ何も返さない", () => {
  const entries = [dir("src"), dir("docs")];

  const found = findHiddenDirs({ entries, isIgnored: () => false });

  assertEquals(found, []);
});

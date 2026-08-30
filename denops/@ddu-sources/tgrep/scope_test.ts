import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import {
  combineGlobs,
  findMarkerDir,
  resolveScope,
  ScopeError,
  scopeRelativeDir,
} from "./scope.ts";

function existsIn(paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

const root = join("/tmp", "repo");

Deno.test("scopeRelativeDir は root 自身なら空文字", () => {
  assertEquals(scopeRelativeDir(root, root), "");
});

Deno.test("scopeRelativeDir は root 相対パスを / 区切りで返す", () => {
  assertEquals(
    scopeRelativeDir(root, join(root, "packages", "core")),
    "packages/core",
  );
});

Deno.test("scopeRelativeDir は root の外を指すと ScopeError", () => {
  assertThrows(
    () => scopeRelativeDir(root, join("/tmp", "elsewhere")),
    ScopeError,
    "outside of the server root",
  );
});

Deno.test("findMarkerDir は cwd から上へ遡って最初の marker 所有ディレクトリを返す", () => {
  const pkg = join(root, "packages", "core");

  assertEquals(
    findMarkerDir({
      cwd: join(pkg, "src"),
      root,
      markers: ["deno.json", "package.json"],
      exists: existsIn([join(pkg, "deno.json"), join(root, "package.json")]),
    }),
    pkg,
  );
});

Deno.test("findMarkerDir は root まで遡って見つからなければ undefined", () => {
  assertEquals(
    findMarkerDir({
      cwd: join(root, "docs"),
      root,
      markers: ["Cargo.toml"],
      exists: existsIn([]),
    }),
    undefined,
  );
});

Deno.test("findMarkerDir は root 自身の marker も見つける", () => {
  assertEquals(
    findMarkerDir({
      cwd: join(root, "docs"),
      root,
      markers: ["go.mod"],
      exists: existsIn([join(root, "go.mod")]),
    }),
    root,
  );
});

Deno.test("resolveScope の all は絞り込まない", () => {
  assertEquals(
    resolveScope({
      scope: "all",
      root,
      cwd: join(root, "src"),
      markers: [],
      exists: existsIn([]),
    }),
    "",
  );
});

Deno.test("resolveScope の cwd は cwd 配下に絞る", () => {
  assertEquals(
    resolveScope({
      scope: "cwd",
      root,
      cwd: join(root, "src", "app"),
      markers: [],
      exists: existsIn([]),
    }),
    "src/app",
  );
});

Deno.test("resolveScope の marker は marker ディレクトリ配下に絞る", () => {
  const pkg = join(root, "packages", "core");

  assertEquals(
    resolveScope({
      scope: "marker",
      root,
      cwd: join(pkg, "src"),
      markers: ["deno.json"],
      exists: existsIn([join(pkg, "deno.json")]),
    }),
    "packages/core",
  );
});

Deno.test("resolveScope の marker は見つからないと ScopeError", () => {
  assertThrows(
    () =>
      resolveScope({
        scope: "marker",
        root,
        cwd: join(root, "docs"),
        markers: ["Cargo.toml"],
        exists: existsIn([]),
      }),
    ScopeError,
    "no root marker",
  );
});

Deno.test("combineGlobs は scope が無ければ globs をそのまま渡す", () => {
  assertEquals(combineGlobs("", ["*.ts", "!vendor/**"]), [
    "*.ts",
    "!vendor/**",
  ]);
});

Deno.test("combineGlobs は scope だけなら scope 配下すべてを include にする", () => {
  assertEquals(combineGlobs("src/app", []), ["src/app/**"]);
});

Deno.test("combineGlobs は include を scope 相対として前置する", () => {
  assertEquals(combineGlobs("src/app", ["*.ts", "*.tsx"]), [
    "src/app/**/*.ts",
    "src/app/**/*.tsx",
  ]);
});

Deno.test("combineGlobs は ! 除外を前置せず素通しする", () => {
  assertEquals(combineGlobs("src/app", ["*.ts", "!*_test.ts"]), [
    "src/app/**/*.ts",
    "!*_test.ts",
  ]);
});

Deno.test("combineGlobs は include が除外だけのとき scope 全体を include に足す", () => {
  assertEquals(combineGlobs("src/app", ["!*_test.ts"]), [
    "src/app/**",
    "!*_test.ts",
  ]);
});

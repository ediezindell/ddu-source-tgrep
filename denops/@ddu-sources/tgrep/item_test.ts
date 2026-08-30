import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import {
  type HighlightGroup,
  matchRowsToItems,
  matchRowToItem,
  parseSearchResult,
  resolveCaseInsensitive,
} from "./item.ts";

const root = join("/tmp", "repo");
const highlights = { path: "Normal", lineNr: "Normal", word: "Search" };

Deno.test("caseMode smart は大文字を含まない入力で insensitive", () => {
  assertEquals(resolveCaseInsensitive("smart", "foo bar"), true);
  assertEquals(resolveCaseInsensitive("smart", "fooBar"), false);
});

Deno.test("caseMode sensitive / insensitive は入力によらず固定", () => {
  assertEquals(resolveCaseInsensitive("sensitive", "foo"), false);
  assertEquals(resolveCaseInsensitive("insensitive", "FOO"), true);
});

Deno.test("parseSearchResult は matches / num_matches / elapsed_ms を取り出す", () => {
  assertEquals(
    parseSearchResult({ matches: [], num_matches: 0, elapsed_ms: 1.5 }),
    { matches: [], numMatches: 0, elapsedMs: 1.5 },
  );
});

Deno.test("parseSearchResult は matches が配列でないと throw", () => {
  assertThrows(
    () => parseSearchResult({ num_matches: 0, elapsed_ms: 0 }),
    TypeError,
    '"matches" array',
  );
});

Deno.test("matchRowToItem は word / action / highlights を組み立てる", () => {
  const item = matchRowToItem({
    row: {
      type: "match",
      file: join("src", "main.rs"),
      line: 42,
      content: "fn main() {\n",
      spans: [[3, 7]],
      columns: [4],
    },
    root,
    highlights,
  });

  const file = join("src", "main.rs");
  assertEquals(item?.word, `${file}:42:4: fn main() {`);
  assertEquals(item?.action, {
    path: join(root, "src", "main.rs"),
    lineNr: 42,
    col: 4,
    text: "fn main() {",
  });
  assertEquals(item?.highlights, [
    { name: "path", hl_group: "Normal", col: 1, width: file.length },
    { name: "lineNr", hl_group: "Normal", col: file.length + 2, width: 2 },
    {
      name: "word",
      hl_group: "Search",
      col: `${file}:42:4: `.length + 4,
      width: 4,
    },
  ]);
});

Deno.test("matchRowToItem はマルチバイト行でも UTF-8 バイト長で計算する", () => {
  const item = matchRowToItem({
    row: {
      type: "match",
      file: "notes.md",
      line: 1,
      content: "あいうquery\n",
      spans: [[9, 14]],
      columns: [10],
    },
    root,
    highlights,
  });

  assertEquals(item?.word, "notes.md:1:10: あいうquery");
  assertEquals(item?.action?.col, 10);
  assertEquals(item?.highlights?.at(-1), {
    name: "word",
    hl_group: "Search",
    col: "notes.md:1:10: ".length + 10,
    width: 5,
  });
});

Deno.test("matchRowToItem は空のハイライトグループを出力しない", () => {
  const item = matchRowToItem({
    row: {
      type: "match",
      file: "a.txt",
      line: 1,
      content: "hit\n",
      spans: [[0, 3]],
      columns: [1],
    },
    root,
    highlights: { path: "", lineNr: "", word: "" },
  });

  assertEquals(item?.highlights, []);
});

Deno.test("matchRowToItem は highlights を一部キーだけ指定しても hl_group が undefined のエントリを作らない", () => {
  const partialHighlights = { word: "Search" } as HighlightGroup;

  const item = matchRowToItem({
    row: {
      type: "match",
      file: "a.txt",
      line: 1,
      content: "hit\n",
      spans: [[0, 3]],
      columns: [1],
    },
    root,
    highlights: partialHighlights,
  });

  assertEquals(
    item?.highlights?.some((highlight) => highlight.hl_group === undefined),
    false,
  );
});

Deno.test("matchRowToItem は col に columns、ハイライト位置に spans を使う", () => {
  const item = matchRowToItem({
    row: {
      type: "match",
      file: "sjis.txt",
      line: 7,
      content: "��query\n",
      spans: [[6, 11]],
      columns: [5],
    },
    root,
    highlights,
  });

  assertEquals(item?.action?.col, 5);
  assertEquals(item?.word, "sjis.txt:7:5: ��query");
  assertEquals(item?.highlights?.at(-1), {
    name: "word",
    hl_group: "Search",
    col: "sjis.txt:7:5: ".length + 6 + 1,
    width: 5,
  });
});

Deno.test("matchRowToItem は match 以外の行を undefined にする", () => {
  assertEquals(
    matchRowToItem({
      row: { type: "binary", file: "a.bin", offset: 0, lines: 3 },
      root,
      highlights,
    }),
    undefined,
  );
});

Deno.test("matchRowToItem は spans の無い match 行で throw する", () => {
  assertThrows(
    () =>
      matchRowToItem({
        row: {
          type: "match",
          file: "a.txt",
          line: 1,
          content: "hit\n",
          columns: [1],
        },
        root,
        highlights,
      }),
    TypeError,
    'no "spans"',
  );
});

Deno.test("matchRowToItem は columns の無い match 行で throw する", () => {
  assertThrows(
    () =>
      matchRowToItem({
        row: {
          type: "match",
          file: "a.txt",
          line: 1,
          content: "hit\n",
          spans: [[0, 3]],
        },
        root,
        highlights,
      }),
    TypeError,
    'no "columns"',
  );
});

Deno.test("matchRowsToItems は match 以外を除外して maxItems で打ち切る", () => {
  const rows = [
    { type: "binary", file: "a.bin", offset: 0, lines: 1 },
    ...["a.txt", "b.txt", "c.txt"].map((file, index) => ({
      type: "match",
      file,
      line: index + 1,
      content: "x\n",
      spans: [[0, 1]],
      columns: [1],
    })),
  ];

  const items = matchRowsToItems({ rows, root, highlights, maxItems: 2 });

  assertEquals(items.length, 2);
  assertEquals(items.map((item) => item.action?.path), [
    join(root, "a.txt"),
    join(root, "b.txt"),
  ]);
});

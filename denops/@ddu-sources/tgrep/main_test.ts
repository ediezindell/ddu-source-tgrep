import { assertEquals } from "@std/assert";
import { join } from "@std/path/join";
import type { Denops } from "@denops/std";
import type { ActionData } from "@shougo/ddu-kind-file";
import type {
  GatherArguments,
  OnEventArguments,
  OnInitArguments,
} from "@shougo/ddu-vim/source";
import type { Item } from "@shougo/ddu-vim/types";
import { type Params, Source } from "./main.ts";
import { startFakeServer } from "./testutil.ts";

Deno.test("params は spec のデフォルト値を返す", () => {
  assertEquals(new Source().params(), {
    cmd: "tgrep",
    input: "",
    scope: "all",
    rootMarkers: [
      "package.json",
      "deno.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
    ],
    globs: [],
    caseMode: "smart",
    fixedString: false,
    types: [],
    maxItems: 10000,
    minInputLength: 2,
    highlights: {
      path: "Normal",
      lineNr: "Normal",
      word: "Search",
    },
    serveArgs: [],
    debug: false,
  });
});

Deno.test("kind は file", () => {
  assertEquals(new Source().kind, "file");
});

const testRoot = join("/tmp", "repo");

function stubDenops(errors: string[] = [], cmds: string[] = []): Denops {
  return {
    cmd(command: string): Promise<void> {
      cmds.push(command);
      return Promise.resolve();
    },
    call(name: string, ...callArgs: unknown[]): Promise<unknown> {
      if (name === "ddu#util#print_error") {
        errors.push(String(callArgs[0]));
      }
      return Promise.resolve(name === "getcwd" ? testRoot : "");
    },
  } as unknown as Denops;
}

function onInitArgs(denops: Denops): OnInitArguments<Params> {
  return {
    denops,
    sourceOptions: { path: testRoot },
    sourceParams: new Source().params(),
  } as unknown as OnInitArguments<Params>;
}

function gatherArgs(denops: Denops, input: string): GatherArguments<Params> {
  return {
    denops,
    context: {},
    options: {},
    sourceOptions: { path: testRoot, volatile: true },
    sourceParams: new Source().params(),
    input,
  } as unknown as GatherArguments<Params>;
}

function closeSource(source: Source, denops: Denops): void {
  source.onEvent(
    { denops, event: "close" } as unknown as OnEventArguments<Params>,
  );
}

function sourceOn(port: number): Source {
  return new Source({
    ensureServer: () => Promise.resolve({ pid: Deno.pid, port }),
    listEntries: () => Promise.resolve([]),
    readGitignore: () => Promise.resolve(""),
    cacheBaseDir: () => "/cache/ddu-source-tgrep",
  });
}

async function drain(
  stream: ReadableStream<Item<ActionData>[]>,
): Promise<Item<ActionData>[][]> {
  const chunks: Item<ActionData>[][] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

Deno.test("gather は minInputLength 未満の入力で何も流さない", async () => {
  const denops = stubDenops();
  const source = sourceOn(1);
  await source.onInit(onInitArgs(denops));

  assertEquals(await drain(source.gather(gatherArgs(denops, "a"))), []);

  closeSource(source, denops);
});

Deno.test("gather は hidden ディレクトリのサーバーとも検索結果をマージする", async () => {
  const makeServer = (file: string) =>
    startFakeServer(async (request, write) => {
      await write(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            matches: [{
              type: "match",
              file,
              line: 1,
              content: "hit\n",
              spans: [[0, 3]],
              columns: [1],
            }],
            num_matches: 1,
            elapsed_ms: 1,
          },
          id: request.id,
        }),
      );
    });
  const rootServer = await makeServer("top.txt");
  const hiddenServer = await makeServer("conf.txt");
  const ports = [rootServer.port, hiddenServer.port];
  let call = 0;
  const source = new Source({
    ensureServer: () =>
      Promise.resolve({ pid: Deno.pid, port: ports[call++] ?? -1 }),
    listEntries: () =>
      Promise.resolve([{ name: ".config", isDirectory: true }]),
    readGitignore: () => Promise.resolve(""),
    cacheBaseDir: () => "/cache/ddu-source-tgrep",
  });
  const denops = stubDenops();
  await source.onInit(onInitArgs(denops));

  const chunks = await drain(source.gather(gatherArgs(denops, "hit")));
  const paths = chunks.flat().map((c) => c.action?.path).sort();

  assertEquals(call, 2);
  assertEquals(paths, [
    join(testRoot, ".config", "conf.txt"),
    join(testRoot, "top.txt"),
  ]);

  closeSource(source, denops);
  await rootServer.close();
  await hiddenServer.close();
});

Deno.test("gather は search の結果を item にして 2 段で流す", async () => {
  const rows = Array.from({ length: 1500 }, (_, index) => ({
    type: "match",
    file: `f${index}.txt`,
    line: index + 1,
    content: "hit\n",
    spans: [[0, 3]],
    columns: [1],
  }));
  const server = await startFakeServer(async (request, write) => {
    await write(
      JSON.stringify({
        jsonrpc: "2.0",
        result: { matches: rows, num_matches: rows.length, elapsed_ms: 1 },
        id: request.id,
      }),
    );
  });
  const denops = stubDenops();
  const source = sourceOn(server.port);
  await source.onInit(onInitArgs(denops));

  const chunks = await drain(source.gather(gatherArgs(denops, "hit")));

  assertEquals(chunks.map((chunk) => chunk.length), [1000, 500]);
  assertEquals(chunks[0][0].word, "f0.txt:1:1: hit");
  assertEquals(chunks[0][0].action?.path, join(testRoot, "f0.txt"));
  assertEquals(
    (server.requests[0].params as Record<string, unknown>).case_insensitive,
    true,
  );

  closeSource(source, denops);
  await server.close();
});

Deno.test("同じエラーは打鍵を重ねても 1 回しか表示しない", async () => {
  const errors: string[] = [];
  const denops = stubDenops(errors);
  const source = new Source({
    ensureServer: () =>
      Promise.reject(new Error("tgrep: server did not start")),
  });
  await source.onInit(onInitArgs(denops));

  await drain(source.gather(gatherArgs(denops, "fo")));
  await drain(source.gather(gatherArgs(denops, "foo")));
  await drain(source.gather(gatherArgs(denops, "foob")));

  assertEquals(errors.length, 2);
  assertEquals(errors.filter((e) => e.includes("did not start")).length, 1);
  assertEquals(errors.filter((e) => e.includes("unavailable")).length, 1);

  closeSource(source, denops);
});

Deno.test("gather は regex 構文エラーを空結果にする", async () => {
  const server = await startFakeServer(async (request, write) => {
    await write(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32602, message: "regex error: unclosed group" },
        id: request.id,
      }),
    );
  });
  const denops = stubDenops();
  const source = sourceOn(server.port);
  await source.onInit(onInitArgs(denops));

  assertEquals(await drain(source.gather(gatherArgs(denops, "foo("))), []);

  closeSource(source, denops);
  await server.close();
});

Deno.test("stale 破棄の debug ログは解決済みの入力を使い、生の args.input は使わない", async () => {
  const cmds: string[] = [];
  const denops = stubDenops([], cmds);
  const server = await startFakeServer(() => {});
  const source = sourceOn(server.port);
  await source.onInit(onInitArgs(denops));

  const stream = source.gather({
    denops,
    context: {},
    options: {},
    sourceOptions: { path: testRoot, volatile: false },
    sourceParams: {
      ...new Source().params(),
      debug: true,
      input: "resolvedPattern",
    },
    input: "rawKeystroke",
  } as unknown as GatherArguments<Params>);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await stream.cancel("test-cancel");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEquals(cmds.some((c) => c.includes("resolvedPattern")), true);
  assertEquals(cmds.some((c) => c.includes("rawKeystroke")), false);

  closeSource(source, denops);
  await server.close();
});

Deno.test("onInit をやり直すとエラーの記憶がリセットされる", async () => {
  const errors: string[] = [];
  const denops = stubDenops(errors);
  const source = new Source({
    ensureServer: () =>
      Promise.reject(new Error("tgrep: server did not start")),
  });

  await source.onInit(onInitArgs(denops));
  await source.onInit(onInitArgs(denops));

  assertEquals(errors.length, 2);

  closeSource(source, denops);
});

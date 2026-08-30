# ddu-source-tgrep 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [tgrep](https://github.com/microsoft/tgrep) サーバーに TCP JSON-RPC で問い合わせて結果を返す、ddu.vim の live grep source プラグインを作る。

**Architecture:** プラグインは `onInit` で検索対象 root を決めて tgrep サーバーを検出（無ければ detached spawn）し、`gather` ごとに `search` RPC を 1 往復投げて結果を ddu の `Item` に変換する。純ロジック（JSON-RPC フレーミング / serve.json パース / root・scope 解決 / caseMode 判定 / レスポンス→item 変換）を副作用のあるコードから分離し、TCP 部分は Deno.listen のフェイクサーバーで検証する。

**Tech Stack:** Deno / TypeScript、denops.vim、ddu.vim (`@shougo/ddu-vim`)、`@shougo/ddu-kind-file`、`@std/*`（jsr）、Vim script（plugin/autoload）。

## Global Constraints

- 承認済み設計 spec は `docs/superpowers/specs/2026-08-30-ddu-source-tgrep-design.md`。**spec に無い挙動・フォールバックを発明しない。**
- エラー処理は fail-loud。tgrep バイナリ不在 / サーバー起動失敗 / 接続失敗は `printError` で表示し、スタンドアロン検索への silent fallback はしない。
- 握り潰してよい唯一の例外は regex 構文エラー（空結果にする）。判定条件は JSON-RPC `code === -32602` かつ `message` が `"regex error: "` で始まること（tgrep 1.0.2 の `build_search_matcher` が全ての regex ビルド失敗にこの prefix を付ける）。
- `scope: "marker"` で marker が見つからない場合はエラー表示。黙って `"all"` に広げない。
- コメントは原則書かない。コードから読めない invariant のみ許可（本計画で明示的に指示した箇所だけ）。
- テストデータはダミー値のみ。実在ホスト名・実在パスを書かない（`/tmp` 配下の一時ディレクトリと `127.0.0.1` のみ使う）。
- ddu の source 規約: `denops/@ddu-sources/tgrep/main.ts` に `export class Source extends BaseSource<Params>`、`kind = "file"`、action 型は `@shougo/ddu-kind-file` の `ActionData`。
- ddu は source の `main.ts` と**同じディレクトリの `deno.json`** を import map として読む（`ddu.vim/denops/ddu/utils.ts` の `tryLoadImportMap`）。よって `denops/@ddu-sources/tgrep/deno.json` は実行時必須。
- jsr の依存バージョンは ddu-source-rg の `denops/@ddu-sources/rg/deno.json` に揃えて固定する（`@denops/std@~8.2.0` / `@shougo/ddu-kind-file@~1.0.0` / `@shougo/ddu-vim@~11.3.0` / `@std/async@~1.5.0` / `@std/path@~1.1.0` / `@std/streams@~1.1.1`）。テスト用に `@std/assert@~1.0.7` を追加する。
- ハイライトの `col` / `width` は UTF-8 バイト長で計算する。
- 検証コマンドは `deno task check` / `deno task lint` / `deno task fmt` / `deno task test`。
- **作業開始前に `git fetch origin` して `origin/main` からブランチを切る**（例: `git checkout -b feat/tgrep-source origin/main`）。各タスク末尾で commit する。

---

## File Structure

| ファイル | 責務 |
|---|---|
| `deno.jsonc` | workspace 定義 + tasks + `denops/ddu-tgrep/` 用の imports |
| `.gitignore` | `.tgrep/`（実機検証で生成されるインデックス） |
| `denops/@ddu-sources/tgrep/deno.json` | source パッケージの import map（ddu が実行時に読む） |
| `denops/@ddu-sources/tgrep/rpc.ts` | 改行区切り JSON-RPC のフレーミング、TCP クライアント、id 相関と stale 破棄、再接続 1 回 |
| `denops/@ddu-sources/tgrep/debug.ts` | `debug: true` 時の `echomsg` 出力 |
| `denops/@ddu-sources/tgrep/server.ts` | serve.json のパス・パース、pid 生存確認、サーバー検出・spawn・停止 |
| `denops/@ddu-sources/tgrep/root.ts` | 検索対象 root の決定（sourceOptions.path → git root → cwd） |
| `denops/@ddu-sources/tgrep/scope.ts` | scope（all / cwd / marker）→ root 相対 glob の解決 |
| `denops/@ddu-sources/tgrep/item.ts` | caseMode 判定、search レスポンスの検証、行 → `Item<ActionData>` 変換 |
| `denops/@ddu-sources/tgrep/main.ts` | `Source` クラス（`params` / `onInit` / `onEvent` / `gather`） |
| `denops/@ddu-sources/tgrep/testutil.ts` | テスト用フェイク tgrep サーバー |
| `denops/ddu-tgrep/deno.json` | `:DduTgrepStop` 用 denops プラグインの import map |
| `denops/ddu-tgrep/main.ts` | denops dispatcher `stop` |
| `plugin/ddu_tgrep.vim` / `autoload/ddu_tgrep.vim` | `:DduTgrepStop` |
| `doc/ddu-source-tgrep.txt` | Vim help |
| `README.md` | インストールと設定例 |

---

### Task 1: パッケージ scaffold と JSON-RPC フレーミング

**Files:**
- Create: `deno.jsonc`
- Create: `.gitignore`
- Create: `denops/@ddu-sources/tgrep/deno.json`
- Create: `denops/@ddu-sources/tgrep/rpc.ts`
- Test: `denops/@ddu-sources/tgrep/rpc_test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `type JsonRpcId = number`
  - `type JsonRpcResponse = { id: JsonRpcId | null; result?: unknown; error?: { code: number; message: string } }`
  - `class RpcMethodError extends Error`（`readonly code: number`）
  - `class RpcConnectionError extends Error`
  - `function encodeRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): string`
  - `function parseResponse(line: string): JsonRpcResponse`
  - `function isRegexSyntaxError(error: { code: number; message: string }): boolean`

- [ ] **Step 1: scaffold ファイルを作る**

`deno.jsonc`:

```jsonc
{
  "lock": false,
  "imports": {
    "@denops/std": "jsr:@denops/std@~8.2.0",
    "@std/path": "jsr:@std/path@~1.1.0"
  },
  "tasks": {
    "cache": "deno install --reload",
    "check": "deno check denops/**/*.ts",
    "lint": "deno lint denops",
    "lint-fix": "deno lint --fix denops",
    "fmt": "deno fmt denops",
    "test": "deno test -A --doc --parallel --shuffle denops/**/*.ts",
    "update": "deno outdated --recursive",
    "upgrade": "deno outdated --recursive --update"
  },
  "workspace": [
    "./denops/@ddu-sources/tgrep",
    "./denops/ddu-tgrep"
  ]
}
```

`.gitignore`:

```gitignore
.tgrep/
```

`denops/@ddu-sources/tgrep/deno.json`:

```json
{
  "imports": {
    "@denops/std": "jsr:@denops/std@~8.2.0",
    "@shougo/ddu-kind-file": "jsr:@shougo/ddu-kind-file@~1.0.0",
    "@shougo/ddu-vim": "jsr:@shougo/ddu-vim@~11.3.0",
    "@std/assert": "jsr:@std/assert@~1.0.7",
    "@std/async": "jsr:@std/async@~1.5.0",
    "@std/path": "jsr:@std/path@~1.1.0",
    "@std/streams": "jsr:@std/streams@~1.1.1"
  }
}
```

`denops/ddu-tgrep/deno.json`（Task 11 で中身を使うが、workspace メンバーとして今作っておく）:

```json
{
  "imports": {
    "@denops/std": "jsr:@denops/std@~8.2.0",
    "@std/async": "jsr:@std/async@~1.5.0",
    "@std/path": "jsr:@std/path@~1.1.0"
  }
}
```

**注:** `@std/async` / `@std/path` は `denops/ddu-tgrep/main.ts` 自身の import には現れないが、実行時には必須。denops.vim はプラグインの `deno.json` を import map として `ImportMapImporter` に渡し、**import グラフ全体**をその map で解決する。`main.ts` が相対 import する `../@ddu-sources/tgrep/root.ts`（`@std/path/*`）と `../@ddu-sources/tgrep/server.ts`（`@std/async/delay`、`@std/path/*`）の bare specifier がここに無いと、`:DduTgrepStop` が実行時に `Import "@std/path/resolve" not a dependency` で失敗する。`deno task check` は workspace 設定で解決するのでこの不具合を検出できない（Task 11 Step 6 の実行時 import 検証で担保する）。

- [ ] **Step 2: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/rpc_test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { encodeRequest, isRegexSyntaxError, parseResponse } from "./rpc.ts";

Deno.test("encodeRequest は JSON-RPC 2.0 リクエストを改行終端の 1 行にする", () => {
  const line = encodeRequest(7, "search", { pattern: "foo" });

  assertEquals(line.endsWith("\n"), true);
  assertEquals(JSON.parse(line), {
    jsonrpc: "2.0",
    method: "search",
    params: { pattern: "foo" },
    id: 7,
  });
});

Deno.test("parseResponse は成功レスポンスから id と result を取り出す", () => {
  const line = '{"jsonrpc":"2.0","result":{"num_matches":1},"id":7}';

  assertEquals(parseResponse(line), { id: 7, result: { num_matches: 1 } });
});

Deno.test("parseResponse はエラーレスポンスから code と message を取り出す", () => {
  const line =
    '{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: nope"},"id":7}';

  assertEquals(parseResponse(line), {
    id: 7,
    error: { code: -32601, message: "Method not found: nope" },
  });
});

Deno.test("parseResponse は id が null のレスポンスを受け付ける", () => {
  const line = '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}';

  assertEquals(parseResponse(line).id, null);
});

Deno.test("parseResponse は result も error も無いレスポンスで throw する", () => {
  assertThrows(
    () => parseResponse('{"jsonrpc":"2.0","id":1}'),
    TypeError,
    "neither result nor error",
  );
});

Deno.test("parseResponse は jsonrpc が 2.0 でないレスポンスで throw する", () => {
  assertThrows(
    () => parseResponse('{"jsonrpc":"1.0","result":1,"id":1}'),
    TypeError,
    "unexpected jsonrpc version",
  );
});

Deno.test("isRegexSyntaxError は -32602 かつ regex error: 前置のときだけ true", () => {
  assertEquals(
    isRegexSyntaxError({ code: -32602, message: "regex error: unclosed group" }),
    true,
  );
  assertEquals(
    isRegexSyntaxError({ code: -32602, message: "unknown encoding: sjis" }),
    false,
  );
  assertEquals(
    isRegexSyntaxError({ code: -32603, message: "regex error: unclosed group" }),
    false,
  );
});
```

- [ ] **Step 3: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/rpc_test.ts`
Expected: FAIL（`Module not found "./rpc.ts"`）

- [ ] **Step 4: `rpc.ts` に最小実装を書く**

```ts
export type JsonRpcId = number;

export type JsonRpcResponse = {
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export class RpcMethodError extends Error {
  override name = "RpcMethodError";

  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export class RpcConnectionError extends Error {
  override name = "RpcConnectionError";
}

export function encodeRequest(
  id: JsonRpcId,
  method: string,
  params: Record<string, unknown>,
): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`;
}

export function parseResponse(line: string): JsonRpcResponse {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`tgrep: response is not a JSON object: ${line}`);
  }

  const object = parsed as Record<string, unknown>;
  if (object.jsonrpc !== "2.0") {
    throw new TypeError(
      `tgrep: unexpected jsonrpc version: ${JSON.stringify(object.jsonrpc)}`,
    );
  }

  const id = object.id;
  if (typeof id !== "number" && id !== null) {
    throw new TypeError(`tgrep: unexpected id: ${JSON.stringify(id)}`);
  }

  if ("error" in object) {
    const error = object.error as Record<string, unknown> | null;
    if (
      error === null || typeof error !== "object" ||
      typeof error.code !== "number" || typeof error.message !== "string"
    ) {
      throw new TypeError(`tgrep: malformed error object: ${line}`);
    }
    return { id, error: { code: error.code, message: error.message } };
  }

  if (!("result" in object)) {
    throw new TypeError(
      `tgrep: response has neither result nor error: ${line}`,
    );
  }

  return { id, result: object.result };
}

export function isRegexSyntaxError(
  error: { code: number; message: string },
): boolean {
  return error.code === -32602 && error.message.startsWith("regex error: ");
}
```

- [ ] **Step 5: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/rpc_test.ts`
Expected: PASS（7 tests）

- [ ] **Step 6: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功（`fmt` はファイルを書き換える可能性がある。書き換わったら差分ごと commit する）

- [ ] **Step 7: Commit**

```bash
git add deno.jsonc .gitignore denops/@ddu-sources/tgrep/deno.json denops/ddu-tgrep/deno.json denops/@ddu-sources/tgrep/rpc.ts denops/@ddu-sources/tgrep/rpc_test.ts
git commit -m "feat(rpc): add JSON-RPC framing and package scaffold"
```

---

### Task 2: TCP クライアント（id 相関・stale 破棄）

**Files:**
- Create: `denops/@ddu-sources/tgrep/testutil.ts`
- Modify: `denops/@ddu-sources/tgrep/rpc.ts`（`RpcClient` を追加）
- Test: `denops/@ddu-sources/tgrep/rpc_client_test.ts`

**Interfaces:**
- Consumes: Task 1 の `encodeRequest` / `parseResponse` / `RpcMethodError` / `RpcConnectionError` / `JsonRpcId`
- Produces:
  - `type FakeServer = { port: number; requests: Record<string, unknown>[]; close: () => Promise<void> }`
  - `function startFakeServer(handle: (request: Record<string, unknown>, write: (line: string) => Promise<void>, close: () => void) => void | Promise<void>): Promise<FakeServer>` — `close` はそのリクエストを受けたソケットだけを切る（Task 3 の再接続テストで使う）。`handle` の戻り型を `void | Promise<void>` にしてあるのは、`write` を呼ばないハンドラを非 async で書けるようにするため（`async` にすると `deno lint` の `require-await` に引っかかる）
  - `class RpcClient`
    - `static connect(port: number): Promise<RpcClient>`
    - `call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>`
    - `get closed(): boolean`
    - `close(): void`

**設計上の invariant（実装時に守ること）:**
- 1 本のソケットを張りっぱなしにして使い回す。レスポンスは 1 本の read loop が受け取り、`id` で pending の resolver に振り分ける。
- `signal` が abort されたら pending から entry を消す。後から届いたレスポンスは entry が無いので捨てられる（= spec の「stale レスポンスの破棄」）。

- [ ] **Step 1: フェイクサーバーを書く**

`denops/@ddu-sources/tgrep/testutil.ts`:

```ts
import { TextLineStream } from "@std/streams/text-line-stream";

export type FakeServer = {
  port: number;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
};

export function startFakeServer(
  handle: (
    request: Record<string, unknown>,
    write: (line: string) => Promise<void>,
    close: () => void,
  ) => void | Promise<void>,
): Promise<FakeServer> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const requests: Record<string, unknown>[] = [];
  const conns: Deno.Conn[] = [];
  const sessions: Promise<void>[] = [];
  const encoder = new TextEncoder();

  const accepting = (async () => {
    for await (const conn of listener) {
      conns.push(conn);
      sessions.push((async () => {
        const writer = conn.writable.getWriter();
        const write = async (line: string) => {
          await writer.write(encoder.encode(`${line}\n`));
        };
        const closeConn = () => {
          try {
            conn.close();
          } catch {
            // Already closed by the client side.
          }
        };
        const lines = conn.readable
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream());
        try {
          for await (const line of lines) {
            if (line.length === 0) {
              continue;
            }
            const request = JSON.parse(line) as Record<string, unknown>;
            requests.push(request);
            await handle(request, write, closeConn);
          }
        } catch {
          // The client disconnected; nothing else to serve on this socket.
        }
      })());
    }
  })();

  return Promise.resolve({
    port: (listener.addr as Deno.NetAddr).port,
    requests,
    close: async () => {
      for (const conn of conns) {
        try {
          conn.close();
        } catch {
          // Already closed by the client side.
        }
      }
      listener.close();
      await Promise.allSettled(sessions);
      await accepting.catch(() => {});
    },
  });
}
```

`startFakeServer` を `async` にしないのは、本体に `await` が無く `deno lint` の `require-await` に引っかかるため（`Deno.listen` は同期）。呼び出し側は `await startFakeServer(...)` のままでよい。

- [ ] **Step 2: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/rpc_client_test.ts`:

```ts
import { assertEquals, assertRejects } from "@std/assert";
import { RpcClient, RpcConnectionError, RpcMethodError } from "./rpc.ts";
import { startFakeServer } from "./testutil.ts";

Deno.test("call はリクエストを送って対応する result を返す", async () => {
  const server = await startFakeServer(async (request, write) => {
    await write(
      JSON.stringify({
        jsonrpc: "2.0",
        result: { echo: request.params },
        id: request.id,
      }),
    );
  });
  const client = await RpcClient.connect(server.port);

  const result = await client.call("search", { pattern: "alpha" });

  assertEquals(result, { echo: { pattern: "alpha" } });
  assertEquals(server.requests[0].method, "search");
  client.close();
  await server.close();
});

Deno.test("id が一致しないレスポンスは捨てて待ち続ける", async () => {
  const server = await startFakeServer(async (request, write) => {
    await write(JSON.stringify({ jsonrpc: "2.0", result: "stale", id: 9999 }));
    await write(JSON.stringify({ jsonrpc: "2.0", result: "fresh", id: request.id }));
  });
  const client = await RpcClient.connect(server.port);

  assertEquals(await client.call("search", { pattern: "beta" }), "fresh");

  client.close();
  await server.close();
});

Deno.test("エラーレスポンスは RpcMethodError になる", async () => {
  const server = await startFakeServer(async (request, write) => {
    await write(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32602, message: "regex error: unclosed group" },
        id: request.id,
      }),
    );
  });
  const client = await RpcClient.connect(server.port);

  const error = await assertRejects(
    () => client.call("search", { pattern: "(" }),
    RpcMethodError,
    "regex error: unclosed group",
  );
  assertEquals(error.code, -32602);

  client.close();
  await server.close();
});

Deno.test("abort した call は reject し、後から届いたレスポンスは捨てられる", async () => {
  let respond: (() => Promise<void>) | undefined;
  const server = await startFakeServer((request, write) => {
    respond = () =>
      write(JSON.stringify({ jsonrpc: "2.0", result: "late", id: request.id }));
  });
  const client = await RpcClient.connect(server.port);
  const controller = new AbortController();

  const pending = client.call("search", { pattern: "gamma" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assertRejects(() => pending);

  await respond?.();
  const afterStale = await client
    .call("status", {}, AbortSignal.timeout(200))
    .catch(() => "no-response");
  assertEquals(afterStale, "no-response");

  client.close();
  await server.close();
});

Deno.test("サーバーが接続を切ると pending が RpcConnectionError で reject する", async () => {
  const server = await startFakeServer(async () => {});
  const client = await RpcClient.connect(server.port);

  const pending = client.call("search", { pattern: "delta" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await server.close();

  await assertRejects(() => pending, RpcConnectionError);
  assertEquals(client.closed, true);
  client.close();
});
```

4 番目のテストの意図: abort 済み id 向けの `"late"` レスポンスが届いても、新しい `status` 呼び出しの resolver には流れ込まない。フェイクサーバーは `status` に応答しないので、タイムアウトして `"no-response"` になるのが正しい（レスポンスが返ってきたら stale が漏れている）。

- [ ] **Step 3: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/rpc_client_test.ts`
Expected: FAIL（`RpcClient` が `rpc.ts` に無い）

- [ ] **Step 4: `rpc.ts` に `RpcClient` を追加**

先頭の import に追加:

```ts
import { abortable } from "@std/async/abortable";
import { TextLineStream } from "@std/streams/text-line-stream";
```

ファイル末尾に追加:

```ts
type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export class RpcClient {
  #conn: Deno.Conn;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #pending = new Map<JsonRpcId, PendingCall>();
  #nextId = 1;
  #closed = false;

  private constructor(conn: Deno.Conn) {
    this.#conn = conn;
    this.#writer = conn.writable.getWriter();
    this.#readLoop();
  }

  static async connect(port: number): Promise<RpcClient> {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    return new RpcClient(conn);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) {
      throw new RpcConnectionError("tgrep: connection is already closed");
    }

    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });

    try {
      await this.#writer.write(
        this.#encoder.encode(encodeRequest(id, method, params)),
      );
      return await (signal ? abortable(response, signal) : response);
    } finally {
      this.#pending.delete(id);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#fail(new RpcConnectionError("tgrep: connection closed by the client"));
    try {
      this.#conn.close();
    } catch {
      // The socket was already torn down by the peer.
    }
  }

  async #readLoop(): Promise<void> {
    const lines = this.#conn.readable
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());

    try {
      for await (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        const response = parseResponse(line);
        if (typeof response.id !== "number") {
          continue;
        }
        const pending = this.#pending.get(response.id);
        if (pending === undefined) {
          continue;
        }
        this.#pending.delete(response.id);
        if (response.error) {
          pending.reject(
            new RpcMethodError(response.error.code, response.error.message),
          );
        } else {
          pending.resolve(response.result);
        }
      }
      this.#fail(new RpcConnectionError("tgrep: server closed the connection"));
    } catch (e: unknown) {
      this.#fail(
        new RpcConnectionError(
          `tgrep: connection error: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  #fail(error: RpcConnectionError): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
```

- [ ] **Step 5: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/rpc_client_test.ts`
Expected: PASS（5 tests）

- [ ] **Step 6: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 7: Commit**

```bash
git add denops/@ddu-sources/tgrep/rpc.ts denops/@ddu-sources/tgrep/rpc_client_test.ts denops/@ddu-sources/tgrep/testutil.ts
git commit -m "feat(rpc): add TCP client with id correlation and stale discard"
```

---

### Task 3: 再接続 1 回の RpcSession

**Files:**
- Modify: `denops/@ddu-sources/tgrep/rpc.ts`（`RpcSession` を追加）
- Test: `denops/@ddu-sources/tgrep/rpc_session_test.ts`

**Interfaces:**
- Consumes: Task 2 の `RpcClient`、Task 1 の `RpcConnectionError`
- Produces:
  - `class RpcSession`
    - `constructor(port: number)`
    - `call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>`
    - `close(): void`

**設計上の invariant:** 再接続の試行は 1 回だけ。2 回目も接続エラーなら呼び出し元に投げる（spec「再接続を 1 回試み、ダメならエラー表示」）。再接続先のポートは同じ（serve.json の読み直しはしない）。

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/rpc_session_test.ts`:

```ts
import { assertEquals, assertRejects } from "@std/assert";
import { RpcConnectionError, RpcSession } from "./rpc.ts";
import { startFakeServer } from "./testutil.ts";

Deno.test("同じソケットを使い回して複数回 call できる", async () => {
  const server = await startFakeServer(async (request, write) => {
    await write(
      JSON.stringify({ jsonrpc: "2.0", result: request.id, id: request.id }),
    );
  });
  const session = new RpcSession(server.port);

  assertEquals(await session.call("search", { pattern: "one" }), 1);
  assertEquals(await session.call("search", { pattern: "two" }), 2);

  session.close();
  await server.close();
});

Deno.test("接続を切られたら 1 回だけ再接続してリトライする", async () => {
  let dropFirst = true;
  const server = await startFakeServer(async (request, write, close) => {
    if (dropFirst) {
      dropFirst = false;
      close();
      return;
    }
    await write(
      JSON.stringify({ jsonrpc: "2.0", result: "reconnected", id: request.id }),
    );
  });
  const session = new RpcSession(server.port);

  assertEquals(await session.call("search", { pattern: "first" }), "reconnected");
  assertEquals(server.requests.length, 2);

  session.close();
  await server.close();
});

Deno.test("再接続後も切られたら RpcConnectionError を投げ、3 回目は試さない", async () => {
  const server = await startFakeServer((_request, _write, close) => {
    close();
  });
  const session = new RpcSession(server.port);

  await assertRejects(
    () => session.call("search", { pattern: "always-dropped" }),
    RpcConnectionError,
  );
  assertEquals(server.requests.length, 2);

  session.close();
  await server.close();
});

Deno.test("サーバーが居ないと RpcConnectionError になる", async () => {
  const server = await startFakeServer(async () => {});
  const port = server.port;
  await server.close();
  const session = new RpcSession(port);

  await assertRejects(
    () => session.call("search", { pattern: "nobody" }),
    RpcConnectionError,
    "cannot connect to 127.0.0.1",
  );

  session.close();
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/rpc_session_test.ts`
Expected: FAIL（`RpcSession` が `rpc.ts` に無い）

- [ ] **Step 3: `rpc.ts` に `RpcSession` を追加**

ファイル末尾に追加:

```ts
export class RpcSession {
  #port: number;
  #client: RpcClient | undefined;

  constructor(port: number) {
    this.#port = port;
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const client = await this.#ensureClient();
      return await client.call(method, params, signal);
    } catch (e: unknown) {
      if (!(e instanceof RpcConnectionError)) {
        throw e;
      }
      this.close();
      const client = await this.#ensureClient();
      return await client.call(method, params, signal);
    }
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }

  async #ensureClient(): Promise<RpcClient> {
    if (this.#client !== undefined && !this.#client.closed) {
      return this.#client;
    }
    try {
      this.#client = await RpcClient.connect(this.#port);
    } catch (e: unknown) {
      throw new RpcConnectionError(
        `tgrep: cannot connect to 127.0.0.1:${this.#port}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return this.#client;
  }
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/rpc_session_test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/rpc.ts denops/@ddu-sources/tgrep/rpc_session_test.ts
git commit -m "feat(rpc): add session that reconnects once on connection loss"
```

---

### Task 4: デバッグロガー

**Files:**
- Create: `denops/@ddu-sources/tgrep/debug.ts`
- Test: `denops/@ddu-sources/tgrep/debug_test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type DebugLogger = (message: string) => Promise<void>`
  - `function vimStringLiteral(text: string): string`
  - `function createDebugLogger(denops: Denops, enabled: boolean): DebugLogger`

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/debug_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import type { Denops } from "@denops/std";
import { createDebugLogger, vimStringLiteral } from "./debug.ts";

function stubDenops(commands: string[]): Denops {
  return {
    cmd(command: string): Promise<void> {
      commands.push(command);
      return Promise.resolve();
    },
  } as unknown as Denops;
}

Deno.test("vimStringLiteral はシングルクォートを二重化して囲む", () => {
  assertEquals(vimStringLiteral("plain"), "'plain'");
  assertEquals(vimStringLiteral("it's"), "'it''s'");
});

Deno.test("enabled が false のロガーは何も実行しない", async () => {
  const commands: string[] = [];

  await createDebugLogger(stubDenops(commands), false)("ignored");

  assertEquals(commands, []);
});

Deno.test("enabled が true のロガーは接頭辞付きで echomsg する", async () => {
  const commands: string[] = [];

  await createDebugLogger(stubDenops(commands), true)("port=1234");

  assertEquals(commands, ["echomsg '[ddu-source-tgrep] port=1234'"]);
});

Deno.test("改行はスペースに畳んで 1 行にする", async () => {
  const commands: string[] = [];

  await createDebugLogger(stubDenops(commands), true)("first\nsecond");

  assertEquals(commands, ["echomsg '[ddu-source-tgrep] first second'"]);
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/debug_test.ts`
Expected: FAIL（`Module not found "./debug.ts"`）

- [ ] **Step 3: `debug.ts` を実装**

```ts
import type { Denops } from "@denops/std";

export type DebugLogger = (message: string) => Promise<void>;

export function vimStringLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export function createDebugLogger(
  denops: Denops,
  enabled: boolean,
): DebugLogger {
  if (!enabled) {
    return () => Promise.resolve();
  }

  return async (message: string) => {
    const oneLine = message.replaceAll(/\r?\n/g, " ");
    await denops.cmd(
      `echomsg ${vimStringLiteral(`[ddu-source-tgrep] ${oneLine}`)}`,
    );
  };
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/debug_test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/debug.ts denops/@ddu-sources/tgrep/debug_test.ts
git commit -m "feat(debug): add echomsg debug logger"
```

---

### Task 5: serve.json のパスとパース、pid 生存確認

**Files:**
- Create: `denops/@ddu-sources/tgrep/server.ts`
- Test: `denops/@ddu-sources/tgrep/server_test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type ServerInfo = { pid: number; port: number }`
  - `function serveJsonPath(root: string): string` — `<root>/.tgrep/serve.json`
  - `function parseServeJson(text: string): ServerInfo` — 契約違反は `TypeError`
  - `function isProcessAlive(pid: number): boolean`

**設計上の invariant:** `isProcessAlive` は `Deno.kill(pid, "SIGCONT")` の例外種別で判定する。`Deno.errors.NotFound` だけが「死んでいる」証拠で、それ以外（`PermissionDenied` / Windows で SIGCONT 非対応の `TypeError`）は生存を否定できないので `true` を返す。これはコードから読めないのでコメントを 1 行だけ残す。

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/server_test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import { isProcessAlive, parseServeJson, serveJsonPath } from "./server.ts";

Deno.test("serveJsonPath は <root>/.tgrep/serve.json を返す", () => {
  assertEquals(
    serveJsonPath(join("/tmp", "workspace")),
    join("/tmp", "workspace", ".tgrep", "serve.json"),
  );
});

Deno.test("parseServeJson は pid と port を取り出す", () => {
  assertEquals(parseServeJson('{"pid":4242,"port":54321}'), {
    pid: 4242,
    port: 54321,
  });
});

Deno.test("parseServeJson は pid が数値でないと throw する", () => {
  assertThrows(
    () => parseServeJson('{"pid":"4242","port":54321}'),
    TypeError,
    'invalid "pid"',
  );
});

Deno.test("parseServeJson は port が範囲外だと throw する", () => {
  assertThrows(
    () => parseServeJson('{"pid":4242,"port":70000}'),
    TypeError,
    'invalid "port"',
  );
});

Deno.test("parseServeJson は JSON オブジェクトでないと throw する", () => {
  assertThrows(
    () => parseServeJson("[1,2,3]"),
    TypeError,
    "not a JSON object",
  );
});

Deno.test("isProcessAlive は自分自身の pid に true を返す", () => {
  assertEquals(isProcessAlive(Deno.pid), true);
});

Deno.test({
  name: "isProcessAlive は終了済みプロセスの pid に false を返す",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "0"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const pid = child.pid;
    await child.status;

    assertEquals(isProcessAlive(pid), false);
  },
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/server_test.ts`
Expected: FAIL（`Module not found "./server.ts"`）

- [ ] **Step 3: `server.ts` を実装**

```ts
import { join } from "@std/path/join";

export type ServerInfo = {
  pid: number;
  port: number;
};

export function serveJsonPath(root: string): string {
  return join(root, ".tgrep", "serve.json");
}

export function parseServeJson(text: string): ServerInfo {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("tgrep: serve.json is not a JSON object");
  }

  const { pid, port } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`tgrep: serve.json has invalid "pid": ${JSON.stringify(pid)}`);
  }
  if (
    typeof port !== "number" || !Number.isInteger(port) || port <= 0 ||
    port > 65535
  ) {
    throw new TypeError(
      `tgrep: serve.json has invalid "port": ${JSON.stringify(port)}`,
    );
  }

  return { pid, port };
}

export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (e: unknown) {
    // Only NotFound proves the process is gone. PermissionDenied (another
    // user's process) and Windows' unsupported-signal TypeError do not.
    return !(e instanceof Deno.errors.NotFound);
  }
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/server_test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/server.ts denops/@ddu-sources/tgrep/server_test.ts
git commit -m "feat(server): add serve.json parsing and pid liveness check"
```

---

### Task 6: サーバー検出・spawn・起動待ち

**Files:**
- Modify: `denops/@ddu-sources/tgrep/server.ts`
- Test: `denops/@ddu-sources/tgrep/server_lifecycle_test.ts`

**Interfaces:**
- Consumes: Task 5 の `ServerInfo` / `serveJsonPath` / `parseServeJson` / `isProcessAlive`、Task 4 の `DebugLogger`
- Produces:
  - `const SPAWN_TIMEOUT_MS = 10_000`
  - `type SpawnArgs = { cmd: string; root: string; serveArgs: string[] }`
  - `type SpawnResult = { commandLine: string[]; detached: boolean; stderr: () => string }`
  - `type EnsureServerArgs = { cmd: string; root: string; serveArgs: string[]; debug: DebugLogger; spawn: (args: SpawnArgs) => SpawnResult; timeoutMs: number }`
  - `function canConnect(port: number): Promise<boolean>`
  - `function probeServer(root: string): Promise<ServerInfo | undefined>`
  - `function spawnServer(args: SpawnArgs): SpawnResult`
  - `function ensureServer(args: EnsureServerArgs): Promise<ServerInfo>`

**設計上の invariant:**
- `probeServer` は「serve.json が読める + pid 生存 + TCP 接続できる」を全部満たしたときだけ `ServerInfo` を返す。serve.json が壊れていたら `parseServeJson` の `TypeError` をそのまま投げる（fail-loud。ユーザーが該当ファイルを消せるようメッセージにパスを含める）。
- flock で先を越された場合（多重 Vim 等）は、勝ったプロセスが serve.json を上書きするので、`ensureServer` の起動待ちポーリングがそれを拾って接続に切り替わる。**起動可否の判定に stderr は使わない**（下記のとおり診断表示にだけ使う）。
- `spawn` を引数で受け取るのは、`ensureServer` を tgrep バイナリ無しでテストするため。
- spawn 直後は `delay` を挟まず**先に 1 回 probe する**。tgrep は listener を bind した直後に serve.json を書くので、既に立ち上がっていた場合の初回起動が 1 ポーリング分（100 ms）速くなる。
- `spawnServer` は `Deno.Command` を作る前に `cmd` の存在を自前で確かめ、無ければその場で throw する。`setsid` を挟むと `spawn()` が起動するのは常に PATH 上にある `setsid` なので**同期 throw では拾えず**、tgrep 不在は子プロセスが exec に失敗して stderr に書くまで分からない。事前確認が無いと、tgrep 未インストール環境では `onInit`（ddu が UI 描画前に await する）が `SPAWN_TIMEOUT_MS` 分固まってから初めてエラーになる。`cmd` にパス区切りが含まれなければ `isExecutableInPath` で PATH を引き、含まれていればそのパスの存在だけを見る。
- 子プロセスの stderr は `piped` にして先頭 `STDERR_CAPTURE_BYTES` だけバッファする。バイナリ不在は上記の事前確認で拾うが、**起動後**に tgrep 側が失敗するケース（flock 衝突・不正な `serveArgs`・index ディレクトリの権限エラー）は stderr にしか出ない。timeout エラーのメッセージと `debug` ログに載せて fail-loud を成立させる。piped のまま放置するとパイプが詰まるので、読み捨てタスクを 1 本回す。
- プロセスグループの分離は `setsid` が PATH にある場合だけ行い（`setsid tgrep serve <root>`）、無ければ従来どおり `unref` のみ。どちらで起動したかは `SpawnResult.detached` に載せて `debug` ログに出す。`unref` のみの場合、端末 Vim の Ctrl-C など Vim のプロセスグループ全体に飛ぶシグナルはサーバーにも届く（Task 12 の doc に明記する）。

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/server_lifecycle_test.ts`:

```ts
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import { delay } from "@std/async/delay";
import {
  ensureServer,
  probeServer,
  type SpawnArgs,
  type SpawnResult,
  spawnServer,
} from "./server.ts";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "ddu-tgrep-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function writeServeJson(
  root: string,
  info: { pid: number; port: number },
): Promise<void> {
  await Deno.mkdir(join(root, ".tgrep"), { recursive: true });
  await Deno.writeTextFile(
    join(root, ".tgrep", "serve.json"),
    JSON.stringify(info),
  );
}

function listenLoopback(): Deno.Listener {
  return Deno.listen({ hostname: "127.0.0.1", port: 0 });
}

const noopDebug = () => Promise.resolve();

function fakeSpawn(
  commandLine: string[],
  stderr = "",
): SpawnResult {
  return { commandLine, detached: false, stderr: () => stderr };
}

Deno.test("probeServer は serve.json が無ければ undefined", async () => {
  await withRoot(async (root) => {
    assertEquals(await probeServer(root), undefined);
  });
});

Deno.test("probeServer は生きている pid と接続可能なポートを返す", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    await writeServeJson(root, { pid: Deno.pid, port });

    assertEquals(await probeServer(root), { pid: Deno.pid, port });

    listener.close();
  });
});

Deno.test("probeServer はポートに接続できなければ undefined", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    await writeServeJson(root, { pid: Deno.pid, port });

    assertEquals(await probeServer(root), undefined);
  });
});

Deno.test("probeServer は壊れた serve.json で throw する", async () => {
  await withRoot(async (root) => {
    await Deno.mkdir(join(root, ".tgrep"), { recursive: true });
    await Deno.writeTextFile(join(root, ".tgrep", "serve.json"), "{}");

    await assertRejects(() => probeServer(root), TypeError, 'invalid "pid"');
  });
});

Deno.test("ensureServer は既存サーバーがあれば spawn しない", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    await writeServeJson(root, { pid: Deno.pid, port });
    let spawned = 0;

    const info = await ensureServer({
      cmd: "tgrep",
      root,
      serveArgs: [],
      debug: noopDebug,
      spawn: () => {
        spawned++;
        return fakeSpawn([]);
      },
      timeoutMs: 1000,
    });

    assertEquals(info, { pid: Deno.pid, port });
    assertEquals(spawned, 0);
    listener.close();
  });
});

Deno.test("ensureServer は spawn 後に serve.json が現れるまで待つ", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    let writing: Promise<void> | undefined;

    const spawn = (args: SpawnArgs): SpawnResult => {
      writing = (async () => {
        await delay(150);
        await writeServeJson(args.root, { pid: Deno.pid, port });
      })();
      return fakeSpawn([args.cmd, "serve", args.root]);
    };

    const info = await ensureServer({
      cmd: "tgrep",
      root,
      serveArgs: [],
      debug: noopDebug,
      spawn,
      timeoutMs: 3000,
    });
    await writing;

    assertEquals(info, { pid: Deno.pid, port });
    listener.close();
  });
});

Deno.test("ensureServer は起動しなければ timeout エラーを投げる", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        ensureServer({
          cmd: "tgrep",
          root,
          serveArgs: [],
          debug: noopDebug,
          spawn: () => fakeSpawn(["tgrep", "serve", root]),
          timeoutMs: 300,
        }),
      Error,
      "server did not start",
    );
  });
});

Deno.test("ensureServer は timeout エラーに子プロセスの stderr を載せる", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        ensureServer({
          cmd: "tgrep",
          root,
          serveArgs: [],
          debug: noopDebug,
          spawn: () =>
            fakeSpawn(
              ["tgrep", "serve", root],
              "another tgrep server already holds the lock",
            ),
          timeoutMs: 300,
        }),
      Error,
      "another tgrep server already holds the lock",
    );
  });
});

Deno.test("ensureServer は spawn 直後の 1 回目の probe で見つかれば待たない", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;

    const spawn = (args: SpawnArgs): SpawnResult => {
      Deno.mkdirSync(join(args.root, ".tgrep"), { recursive: true });
      Deno.writeTextFileSync(
        join(args.root, ".tgrep", "serve.json"),
        JSON.stringify({ pid: Deno.pid, port }),
      );
      return fakeSpawn([args.cmd, "serve", args.root]);
    };

    const info = await ensureServer({
      cmd: "tgrep",
      root,
      serveArgs: [],
      debug: noopDebug,
      spawn,
      timeoutMs: 0,
    });

    assertEquals(info, { pid: Deno.pid, port });
    listener.close();
  });
});

Deno.test({
  name: "spawnServer は cmd が見つからなければ spawn せずに throw する",
  ignore: Deno.build.os === "windows",
  fn: () => {
    assertThrows(
      () =>
        spawnServer({
          cmd: "tgrep-not-installed-xyz",
          root: "/tmp",
          serveArgs: [],
        }),
      Error,
      "tgrep-not-installed-xyz",
    );
    assertThrows(
      () =>
        spawnServer({
          cmd: "/nonexistent/bin/tgrep",
          root: "/tmp",
          serveArgs: [],
        }),
      Error,
      "/nonexistent/bin/tgrep",
    );
  },
});

Deno.test("ensureServer は spawn が throw したら timeout を待たずに失敗する", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        ensureServer({
          cmd: "tgrep-not-installed-xyz",
          root,
          serveArgs: [],
          debug: noopDebug,
          spawn: () => {
            throw new Error(
              "tgrep: command not found: tgrep-not-installed-xyz",
            );
          },
          timeoutMs: 60_000,
        }),
      Error,
      "tgrep-not-installed-xyz",
    );
  });
});
```

`timeoutMs: 0` のテストは「spawn → delay → probe」の順だと 1 回も probe せずに timeout するので必ず落ち、「spawn → probe →（必要なら delay）」の順のときだけ通る。時間の長短ではなく順序を判定するので、負荷のかかったマシンでも結果が変わらない。

`spawnServer` の 2 ケースは PATH 探索する裸の名前とパス付きの指定の両方を見る。`setsid` を挟む環境では実在しない `cmd` でも `spawn()` は成功してしまうので、事前確認が無ければ throw せずに `Deno.Command` を作ってしまい落ちる。POSIX 前提の判定なので Windows では `ignore` する。

最後のテストは `timeoutMs: 60_000` を渡す。`ensureServer` が spawn の例外を握り潰してポーリングに入ってしまうと 60 秒待ってから別のメッセージで落ちるので、「即座に、spawn のエラーを載せて失敗する」ことだけが通る形になっている。時計は読まない。

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/server_lifecycle_test.ts`
Expected: FAIL（`probeServer` / `ensureServer` が `server.ts` に無い）

- [ ] **Step 3: `server.ts` に追記**

先頭の import に追加:

```ts
import { delay } from "@std/async/delay";
import type { DebugLogger } from "./debug.ts";
```

ファイル末尾に追加:

```ts
export const SPAWN_TIMEOUT_MS = 10_000;

const POLL_INTERVAL_MS = 100;
const STDERR_CAPTURE_BYTES = 4096;

export type SpawnArgs = {
  cmd: string;
  root: string;
  serveArgs: string[];
};

export type SpawnResult = {
  commandLine: string[];
  detached: boolean;
  stderr: () => string;
};

export type EnsureServerArgs = {
  cmd: string;
  root: string;
  serveArgs: string[];
  debug: DebugLogger;
  spawn: (args: SpawnArgs) => SpawnResult;
  timeoutMs: number;
};

export async function canConnect(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

export async function probeServer(
  root: string,
): Promise<ServerInfo | undefined> {
  const path = serveJsonPath(root);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw e;
  }

  const info = parseServeJson(text);
  if (!isProcessAlive(info.pid)) {
    return undefined;
  }
  return (await canConnect(info.port)) ? info : undefined;
}

function isExecutableInPath(name: string): boolean {
  if (Deno.build.os === "windows") {
    return false;
  }
  const paths = Deno.env.get("PATH");
  if (paths === undefined) {
    return false;
  }
  for (const dir of paths.split(":")) {
    if (dir.length === 0) {
      continue;
    }
    try {
      Deno.lstatSync(join(dir, name));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function commandExists(cmd: string): boolean {
  if (cmd.includes("/")) {
    try {
      Deno.lstatSync(cmd);
      return true;
    } catch {
      return false;
    }
  }
  return isExecutableInPath(cmd);
}

export function spawnServer(args: SpawnArgs): SpawnResult {
  if (Deno.build.os !== "windows" && !commandExists(args.cmd)) {
    throw new Error(
      `tgrep: command not found: ${args.cmd} (install tgrep, or set the "cmd" source param to its path)`,
    );
  }

  const serveLine = [args.cmd, "serve", args.root, ...args.serveArgs];
  const detached = isExecutableInPath("setsid");
  const commandLine = detached ? ["setsid", ...serveLine] : serveLine;

  const child = new Deno.Command(commandLine[0], {
    args: commandLine.slice(1),
    cwd: args.root,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let captured = "";
  const decoder = new TextDecoder();
  (async () => {
    for await (const chunk of child.stderr) {
      if (captured.length < STDERR_CAPTURE_BYTES) {
        captured += decoder.decode(chunk, { stream: true });
      }
    }
  })().catch(() => {});
  child.unref();

  return {
    commandLine,
    detached,
    stderr: () => captured.slice(0, STDERR_CAPTURE_BYTES),
  };
}

export async function ensureServer(args: EnsureServerArgs): Promise<ServerInfo> {
  const path = serveJsonPath(args.root);

  const existing = await probeServer(args.root);
  if (existing !== undefined) {
    await args.debug(
      `connected to running server: root=${args.root} serveJson=${path} pid=${existing.pid} port=${existing.port}`,
    );
    return existing;
  }

  let spawned: SpawnResult;
  try {
    spawned = args.spawn({
      cmd: args.cmd,
      root: args.root,
      serveArgs: args.serveArgs,
    });
  } catch (e: unknown) {
    throw new Error(
      `tgrep: failed to spawn "${args.cmd} serve ${args.root}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  await args.debug(
    `spawned server: ${spawned.commandLine.join(" ")} detached=${spawned.detached}`,
  );

  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    const info = await probeServer(args.root);
    if (info !== undefined) {
      await args.debug(
        `server ready: root=${args.root} serveJson=${path} pid=${info.pid} port=${info.port} stderr=${
          JSON.stringify(spawned.stderr())
        }`,
      );
      return info;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }

  const stderr = spawned.stderr();
  throw new Error(
    `tgrep: server did not start within ${args.timeoutMs}ms (root=${args.root}, serveJson=${path})${
      stderr.length === 0 ? "" : `; stderr: ${stderr}`
    }`,
  );
}
```

**注:** `setsid` が PATH にあれば `setsid tgrep serve <root>` で起動してプロセスグループを分離する。無ければ `child.unref()` だけで Vim 終了後もサーバーを残す形になり、Vim のプロセスグループ全体に飛ぶシグナル（端末 Vim での Ctrl-C 等）がサーバーにも届く。spec が言う「プロセスグループ分離」は Deno の `Deno.Command` だけでは実現できないので、この 2 モードと `unref` のみの場合の制約を Task 12 の doc に記載する。

**注:** `commandExists` を通すのは POSIX だけにする。`isExecutableInPath` は `PATH` を `:` 区切り・拡張子なしで引く POSIX 前提の実装で、Windows では常に `false` を返す（`setsid` の判定としてはそれが正しい）。Windows では `setsid` を挟まないので `commandLine[0]` が `cmd` そのものになり、バイナリ不在は `spawn()` が同期 throw して `ensureServer` の `catch` が拾う。

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/server_lifecycle_test.ts`
Expected: PASS（11 tests。Windows では `spawnServer` の 1 本が ignored）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/server.ts denops/@ddu-sources/tgrep/server_lifecycle_test.ts
git commit -m "feat(server): detect, spawn and wait for the tgrep server"
```

---

### Task 7: 検索対象 root の決定

**Files:**
- Create: `denops/@ddu-sources/tgrep/root.ts`
- Test: `denops/@ddu-sources/tgrep/root_test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `function pathExists(path: string): boolean`
  - `function findGitRoot(startDir: string, exists: (path: string) => boolean): string | undefined`
  - `function resolveRootFrom(args: { sourcePath: string; cwd: string; exists: (path: string) => boolean }): string`

**設計上の invariant:** spec のとおり `sourceOptions.path` → cwd から `.git` を上方探索 → 見つからなければ cwd。`.git` はディレクトリとは限らない（worktree / submodule ではファイル）ので存在判定だけを使う。

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/root_test.ts`:

```ts
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
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/root_test.ts`
Expected: FAIL（`Module not found "./root.ts"`）

- [ ] **Step 3: `root.ts` を実装**

```ts
import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import { resolve } from "@std/path/resolve";

export function pathExists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      return false;
    }
    throw e;
  }
}

export function findGitRoot(
  startDir: string,
  exists: (path: string) => boolean,
): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (exists(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function resolveRootFrom(args: {
  sourcePath: string;
  cwd: string;
  exists: (path: string) => boolean;
}): string {
  if (args.sourcePath.length !== 0) {
    return resolve(args.sourcePath);
  }
  return findGitRoot(args.cwd, args.exists) ?? resolve(args.cwd);
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/root_test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/root.ts denops/@ddu-sources/tgrep/root_test.ts
git commit -m "feat(root): resolve the search root from sourceOptions, git root or cwd"
```

---

### Task 8: scope 解決

**Files:**
- Create: `denops/@ddu-sources/tgrep/scope.ts`
- Test: `denops/@ddu-sources/tgrep/scope_test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type Scope = "all" | "cwd" | "marker"`
  - `class ScopeError extends Error`
  - `function scopeRelativeDir(root: string, dir: string): string`
  - `function findMarkerDir(args: { cwd: string; root: string; markers: string[]; exists: (path: string) => boolean }): string | undefined`
  - `function resolveScope(args: { scope: Scope; root: string; cwd: string; markers: string[]; exists: (path: string) => boolean }): string`
  - `function combineGlobs(prefix: string, globs: string[]): string[]`

**設計上の invariant:**
- `resolveScope` は絞り込み先ディレクトリの **root 相対パス**を返す。root 全体なら `""`。
- glob のセパレータは常に `/`（Windows のバックスラッシュは変換する）。
- `marker` が見つからなければ `ScopeError`。`all` に広げない。
- 対象ディレクトリが root の外なら `ScopeError`。
- **`combineGlobs` は scope と `globs` を AND 合成する。** tgrep の `GlobFilter` は include を OR で評価する（include が 1 つでもあれば「いずれかの include にマッチ」AND「どの exclude にもマッチしない」）ので、scope の `"src/app/**"` と `globs` の `"*.ts"` を素朴に並べると root 全体の `.ts` がヒットして scope が無効化される。そこで **`globs` の include は scope 相対として解釈**し、scope が有効なときは prefix を前置して 1 本の include にまとめる（scope が `src/app` なら `*.ts` → `src/app/**/*.ts`）。`!` 前置の exclude は前置せずそのまま渡す（include が既に scope 内へ絞っているので、exclude の対象が root 全体でも過剰除外にはならない）。`scope: "all"`（prefix が `""`）のときは何も前置しない。ここで include が scope 相対・exclude が root 相対という非対称が生じる — tgrep の `compile_glob` は `/` を含まないパターンにだけ `**/` を前置するので、`!*_test.ts` は任意の深さで効くが `!vendor/**` は root 直下の `vendor` にしか効かない。spec が「`!` 除外はそのまま渡す」と確定しているので挙動は変えず、Task 12 の doc で明示する。

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/scope_test.ts`:

```ts
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
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/scope_test.ts`
Expected: FAIL（`Module not found "./scope.ts"`）

- [ ] **Step 3: `scope.ts` を実装**

```ts
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
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/scope_test.ts`
Expected: PASS（15 tests）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/scope.ts denops/@ddu-sources/tgrep/scope_test.ts
git commit -m "feat(scope): resolve all/cwd/marker scope and combine it with user globs"
```

---

### Task 9: caseMode 判定と検索レスポンスの item 変換

**Files:**
- Create: `denops/@ddu-sources/tgrep/item.ts`
- Test: `denops/@ddu-sources/tgrep/item_test.ts`

**Interfaces:**
- Consumes: `@shougo/ddu-vim/types` の `Item`、`@shougo/ddu-kind-file` の `ActionData`
- Produces:
  - `type CaseMode = "smart" | "sensitive" | "insensitive"`
  - `type HighlightGroup = { path: string; lineNr: string; word: string }`
  - `type SearchResult = { matches: unknown[]; numMatches: number; elapsedMs: number }`
  - `function resolveCaseInsensitive(mode: CaseMode, input: string): boolean`
  - `function parseSearchResult(value: unknown): SearchResult`
  - `function matchRowToItem(args: { row: unknown; root: string; highlights: HighlightGroup }): Item<ActionData> | undefined`
  - `function matchRowsToItems(args: { rows: unknown[]; root: string; highlights: HighlightGroup; maxItems: number }): Item<ActionData>[]`

**設計上の invariant:**
- `word` は `"<file>:<line>:<col>: <text>"`。`col` は 1 始まりのバイト位置。
- `action.path` は `resolve(root, file)`（tgrep の `file` は常にインデックス root 相対）。
- **`col`（`word` の表示と `action.col`）は `columns[0]` を使う。** tgrep の `columns` はエンコーディング補正（`to_source_positions`）を通した 1 始まりの列で、`spans` は補正前の lossy-decode 空間のバイトオフセット。UTF-8 ファイルでは fixups が空で両者は一致するが、非 UTF-8 ファイルでは差が出る。カーソル移動先は実ファイル上の位置でなければならないので `columns` が正しい。
- **ハイライトの位置と幅は `spans[0]` から算出する。** ハイライトが指すのは ddu が描画する `word` 文字列上の位置で、その中身は lossy-decode された `content` なので、`spans` の空間と一致する。`col` = `utf8Length(header) + spans[0][0] + 1`、`width` = `spans[0][1] - spans[0][0]`。
- ハイライトの `col` / `width` は UTF-8 バイト長。
- `type` が `"match"` 以外の行（`context` / `binary`）は `undefined` を返して読み飛ばす。
- `match` 行に `spans` / `columns` が無いのは契約違反として `TypeError`（この source は常に `detail: true` を送るため、どちらも必ず付く）。

- [ ] **Step 1: 失敗するテストを書く**

`denops/@ddu-sources/tgrep/item_test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import {
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
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/item_test.ts`
Expected: FAIL（`Module not found "./item.ts"`）

- [ ] **Step 3: `item.ts` を実装**

```ts
import type { ActionData } from "@shougo/ddu-kind-file";
import type { Item, ItemHighlight } from "@shougo/ddu-vim/types";
import { resolve } from "@std/path/resolve";

export type CaseMode = "smart" | "sensitive" | "insensitive";

export type HighlightGroup = {
  path: string;
  lineNr: string;
  word: string;
};

export type SearchResult = {
  matches: unknown[];
  numMatches: number;
  elapsedMs: number;
};

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function resolveCaseInsensitive(
  mode: CaseMode,
  input: string,
): boolean {
  switch (mode) {
    case "smart":
      return input === input.toLowerCase();
    case "sensitive":
      return false;
    case "insensitive":
      return true;
    default:
      throw new TypeError(`tgrep: unknown caseMode: ${String(mode)}`);
  }
}

export function parseSearchResult(value: unknown): SearchResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tgrep: search result is not a JSON object");
  }

  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.matches)) {
    throw new TypeError('tgrep: search result has no "matches" array');
  }
  if (
    typeof object.num_matches !== "number" ||
    typeof object.elapsed_ms !== "number"
  ) {
    throw new TypeError(
      'tgrep: search result has invalid "num_matches" or "elapsed_ms"',
    );
  }

  return {
    matches: object.matches,
    numMatches: object.num_matches,
    elapsedMs: object.elapsed_ms,
  };
}

export function matchRowToItem(args: {
  row: unknown;
  root: string;
  highlights: HighlightGroup;
}): Item<ActionData> | undefined {
  if (args.row === null || typeof args.row !== "object") {
    throw new TypeError("tgrep: match row is not a JSON object");
  }

  const row = args.row as Record<string, unknown>;
  if (row.type !== "match") {
    return undefined;
  }

  const { file, line, content } = row;
  if (
    typeof file !== "string" || typeof line !== "number" ||
    typeof content !== "string"
  ) {
    throw new TypeError(`tgrep: malformed match row: ${JSON.stringify(row)}`);
  }

  if (!Array.isArray(row.spans) || row.spans.length === 0) {
    throw new TypeError(
      `tgrep: match row has no "spans": ${JSON.stringify(row)}`,
    );
  }
  const span: unknown = row.spans[0];
  if (
    !Array.isArray(span) || typeof span[0] !== "number" ||
    typeof span[1] !== "number"
  ) {
    throw new TypeError(
      `tgrep: match row has malformed "spans": ${JSON.stringify(row)}`,
    );
  }
  const startByte: number = span[0];
  const endByte: number = span[1];

  if (
    !Array.isArray(row.columns) || typeof row.columns[0] !== "number"
  ) {
    throw new TypeError(
      `tgrep: match row has no "columns": ${JSON.stringify(row)}`,
    );
  }
  const col: number = row.columns[0];

  const text = content.replace(/\r?\n$/, "");
  const header = `${file}:${line}:${col}: `;

  const highlights: ItemHighlight[] = [];
  if (args.highlights.path !== "") {
    highlights.push({
      name: "path",
      hl_group: args.highlights.path,
      col: 1,
      width: utf8Length(file),
    });
  }
  if (args.highlights.lineNr !== "") {
    highlights.push({
      name: "lineNr",
      hl_group: args.highlights.lineNr,
      col: utf8Length(file) + 2,
      width: utf8Length(String(line)),
    });
  }
  if (args.highlights.word !== "" && endByte > startByte) {
    highlights.push({
      name: "word",
      hl_group: args.highlights.word,
      col: utf8Length(header) + startByte + 1,
      width: endByte - startByte,
    });
  }

  return {
    word: header + text,
    action: {
      path: resolve(args.root, file),
      lineNr: line,
      col,
      text,
    },
    highlights,
  };
}

export function matchRowsToItems(args: {
  rows: unknown[];
  root: string;
  highlights: HighlightGroup;
  maxItems: number;
}): Item<ActionData>[] {
  const items: Item<ActionData>[] = [];
  for (const row of args.rows) {
    if (items.length >= args.maxItems) {
      break;
    }
    const item = matchRowToItem({
      row,
      root: args.root,
      highlights: args.highlights,
    });
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items;
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/item_test.ts`
Expected: PASS（12 tests）

- [ ] **Step 5: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 6: Commit**

```bash
git add denops/@ddu-sources/tgrep/item.ts denops/@ddu-sources/tgrep/item_test.ts
git commit -m "feat(item): convert tgrep search rows into ddu items"
```

---

### Task 10: Source 本体

**Files:**
- Create: `denops/@ddu-sources/tgrep/main.ts`
- Test: `denops/@ddu-sources/tgrep/main_test.ts`

**Interfaces:**
- Consumes: Task 1-9 の全モジュール
- Produces:
  - `export type Params`（spec の source params テーブルどおりの 13 キー）
  - `export type SourceDeps = { ensureServer?: (args: EnsureServerArgs) => Promise<ServerInfo>; spawn?: (args: SpawnArgs) => SpawnResult }`
  - `class Source extends BaseSource<Params>`
    - `constructor(deps?: SourceDeps)` — 省略時は `server.ts` の実装を使う。ddu の loader は `new Source()` で生成するので、引数は必ず省略可能にする
    - `override kind = "file"`
    - `override onInit(args: OnInitArguments<Params>): Promise<void>`
    - `override onEvent(args: OnEventArguments<Params>): void`
    - `gather(args: GatherArguments<Params>): ReadableStream<Item<ActionData>[]>`
    - `params(): Params`

**設計上の invariant:**
- `onInit` は root を決めてサーバーを確保し `RpcSession` を作る。失敗したら `printError` して session を持たない（`gather` が毎回エラーを出すのではなく、原因は onInit の 1 回だけ表示し、gather は「利用不可」を伝える）。
- **`onInit` は前回の `#session` を `close()` してから差し替える。** ddu の Source インスタンスは loader にキャッシュされた singleton で、`onInit` は `ddu#start` のたびに呼ばれる（`isInitialized` ガードは無い）。閉じずに `undefined` で上書きすると TCP ソケットが 1 本ずつ残る。
- **`printError` は同一メッセージを Source 内で記憶して 1 回だけ出す（`#reportOnce`）。記憶は `onInit` の冒頭でリセットする。** live grep は 1 打鍵 1 gather なので、サーバー利用不可や `ScopeError` を素直に毎回表示すると同じメッセージが打鍵回数だけ並ぶ。上の invariant（原因は 1 回だけ表示）を実装として成立させるのがこの仕組み。抑制するのは表示だけで、握り潰しはしない（fail-loud は維持）。
- `gather` は abort シグナルを `RpcSession.call` に渡す。`ReadableStream` の `cancel` で abort し、後から届いたレスポンスは `RpcClient` 側で捨てられる。
- 2 段チャンク: 先に 1000 件、残りをまとめて 1 回。
- 例外の分岐は 3 つだけ — abort 済み / regex 構文エラー / それ以外（`#reportOnce`）。
- `ensureServer` / `spawn` はコンストラクタで差し替えられる。テストから `#root` / `#session` を直接いじる public API は生やさない（spec に無い公開面を増やさないため）。テストは実際に `onInit` を通してフェイクサーバーのポートを掴ませ、後片付けは `onEvent({ event: "close" })` で行う。

- [ ] **Step 1: params のテストを書く**

`denops/@ddu-sources/tgrep/main_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { Source } from "./main.ts";

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
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/main_test.ts`
Expected: FAIL（`Module not found "./main.ts"`）

- [ ] **Step 3: `main.ts` を実装**

```ts
import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import type { ActionData } from "@shougo/ddu-kind-file";
import {
  BaseSource,
  type GatherArguments,
  type OnEventArguments,
  type OnInitArguments,
} from "@shougo/ddu-vim/source";
import type { Item } from "@shougo/ddu-vim/types";
import { printError, treePath2Filename } from "@shougo/ddu-vim/utils";

import { createDebugLogger } from "./debug.ts";
import {
  type CaseMode,
  type HighlightGroup,
  matchRowsToItems,
  parseSearchResult,
  resolveCaseInsensitive,
} from "./item.ts";
import { pathExists, resolveRootFrom } from "./root.ts";
import { isRegexSyntaxError, RpcMethodError, RpcSession } from "./rpc.ts";
import { combineGlobs, resolveScope, type Scope } from "./scope.ts";
import { ensureServer, SPAWN_TIMEOUT_MS, spawnServer } from "./server.ts";

const ENQUEUE_SIZE_1ST = 1000;

export type Params = {
  cmd: string;
  input: string;
  scope: Scope;
  rootMarkers: string[];
  globs: string[];
  caseMode: CaseMode;
  fixedString: boolean;
  types: string[];
  maxItems: number;
  minInputLength: number;
  highlights: HighlightGroup;
  serveArgs: string[];
  debug: boolean;
};

async function currentCwd(denops: Denops): Promise<string> {
  return await fn.getcwd(denops) as string;
}

function reportKey(value: unknown): string {
  return value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value);
}

export class Source extends BaseSource<Params> {
  override kind = "file";

  #root = "";
  #session: RpcSession | undefined;
  #reported = new Set<string>();

  override async onInit(args: OnInitArguments<Params>): Promise<void> {
    const debug = createDebugLogger(args.denops, args.sourceParams.debug);
    const sourcePath = args.sourceOptions.path.length !== 0
      ? treePath2Filename(args.sourceOptions.path)
      : "";
    this.#root = resolveRootFrom({
      sourcePath,
      cwd: await currentCwd(args.denops),
      exists: pathExists,
    });

    this.#reported.clear();
    this.#session?.close();
    this.#session = undefined;
    try {
      const info = await ensureServer({
        cmd: args.sourceParams.cmd,
        root: this.#root,
        serveArgs: args.sourceParams.serveArgs,
        debug,
        spawn: spawnServer,
        timeoutMs: SPAWN_TIMEOUT_MS,
      });
      this.#session = new RpcSession(info.port);
    } catch (e: unknown) {
      await this.#reportOnce(args.denops, e);
    }
  }

  #reportOnce(denops: Denops, error: unknown): Promise<void> {
    const key = reportKey(error);
    if (this.#reported.has(key)) {
      return Promise.resolve();
    }
    this.#reported.add(key);
    return printError(denops, error);
  }

  override onEvent(args: OnEventArguments<Params>): void {
    if (args.event === "close" || args.event === "cancel") {
      this.#session?.close();
    }
  }

  gather(args: GatherArguments<Params>): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    const root = this.#root;
    const session = this.#session;
    const params = args.sourceParams;
    const reportOnce = (error: unknown) =>
      this.#reportOnce(args.denops, error);

    return new ReadableStream({
      async start(controller) {
        const debug = createDebugLogger(args.denops, params.debug);
        try {
          const input = args.sourceOptions.volatile
            ? args.input
            : params.input;
          if (input.length < params.minInputLength) {
            return;
          }
          if (session === undefined) {
            await reportOnce(
              "tgrep: the server is unavailable. See :messages for the failure reported while the source was initialized.",
            );
            return;
          }

          const globs = combineGlobs(
            resolveScope({
              scope: params.scope,
              root,
              cwd: await currentCwd(args.denops),
              markers: params.rootMarkers,
              exists: pathExists,
            }),
            params.globs,
          );
          const caseInsensitive = resolveCaseInsensitive(
            params.caseMode,
            input,
          );
          await debug(
            `search: pattern=${input} glob=${JSON.stringify(globs)} case_insensitive=${caseInsensitive}`,
          );

          const startedAt = Date.now();
          const raw = await session.call("search", {
            pattern: input,
            case_insensitive: caseInsensitive,
            fixed_string: params.fixedString,
            glob: globs,
            types: params.types,
            detail: true,
            positions: false,
          }, abortController.signal);

          const result = parseSearchResult(raw);
          const items = matchRowsToItems({
            rows: result.matches,
            root,
            highlights: params.highlights,
            maxItems: params.maxItems,
          });
          await debug(
            `search done: items=${items.length} num_matches=${result.numMatches} elapsed_ms=${result.elapsedMs} roundtrip_ms=${
              Date.now() - startedAt
            }`,
          );

          if (items.length !== 0) {
            controller.enqueue(items.slice(0, ENQUEUE_SIZE_1ST));
          }
          if (items.length > ENQUEUE_SIZE_1ST) {
            controller.enqueue(items.slice(ENQUEUE_SIZE_1ST));
          }
        } catch (e: unknown) {
          if (abortController.signal.aborted) {
            await debug(`search discarded as stale: pattern=${args.input}`);
          } else if (e instanceof RpcMethodError && isRegexSyntaxError(e)) {
            await debug(`ignored regex syntax error: ${e.message}`);
          } else {
            await reportOnce(e);
          }
        } finally {
          controller.close();
        }
      },

      cancel(reason): void {
        abortController.abort(reason);
      },
    });
  }

  params(): Params {
    return {
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
    };
  }
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/main_test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: gather のテストを書いて失敗を確認**

テストは `Source` の private を直接いじらず、フェイクサーバーのポートを返す `ensureServer` を注入して実際に `onInit` を通す。後片付けは公開 API の `onEvent({ event: "close" })` で行う。

`main_test.ts` の先頭の import 行を次の 8 行に置き換え、既存の 2 テストの後ろに追記する:

```ts
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
```

追記するテスト:

```ts
const testRoot = join("/tmp", "repo");

function stubDenops(errors: string[] = []): Denops {
  return {
    cmd(): Promise<void> {
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

Deno.test("同じエラーは打鍵を重ねても 1 回しか表示しない", async () => {
  const errors: string[] = [];
  const denops = stubDenops(errors);
  const source = new Source({
    ensureServer: () => Promise.reject(new Error("tgrep: server did not start")),
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

Deno.test("onInit をやり直すとエラーの記憶がリセットされる", async () => {
  const errors: string[] = [];
  const denops = stubDenops(errors);
  const source = new Source({
    ensureServer: () => Promise.reject(new Error("tgrep: server did not start")),
  });

  await source.onInit(onInitArgs(denops));
  await source.onInit(onInitArgs(denops));

  assertEquals(errors.length, 2);

  closeSource(source, denops);
});
```

- [ ] **Step 6: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/main_test.ts`
Expected: FAIL（`Source` のコンストラクタが引数を取らないので `new Source({ ensureServer: ... })` が型エラー）

- [ ] **Step 7: `Source` に依存注入コンストラクタを追加**

`main.ts` の import に型を足す:

```ts
import {
  ensureServer,
  type EnsureServerArgs,
  type ServerInfo,
  SPAWN_TIMEOUT_MS,
  type SpawnArgs,
  spawnServer,
  type SpawnResult,
} from "./server.ts";
```

`Params` の後ろに追加:

```ts
export type SourceDeps = {
  ensureServer?: (args: EnsureServerArgs) => Promise<ServerInfo>;
  spawn?: (args: SpawnArgs) => SpawnResult;
};
```

`Source` のフィールド宣言に 2 つ足してコンストラクタを追加し、`onInit` の呼び出しを差し替える:

```ts
  #ensureServer: (args: EnsureServerArgs) => Promise<ServerInfo>;
  #spawn: (args: SpawnArgs) => SpawnResult;

  constructor(deps: SourceDeps = {}) {
    super();
    this.#ensureServer = deps.ensureServer ?? ensureServer;
    this.#spawn = deps.spawn ?? spawnServer;
  }
```

```ts
      const info = await this.#ensureServer({
        cmd: args.sourceParams.cmd,
        root: this.#root,
        serveArgs: args.sourceParams.serveArgs,
        debug,
        spawn: this.#spawn,
        timeoutMs: SPAWN_TIMEOUT_MS,
      });
```

引数を省略可能にしてあるのは、ddu の loader が `new Source()` で生成するため。

- [ ] **Step 8: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/main_test.ts`
Expected: PASS（7 tests）

- [ ] **Step 9: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功

- [ ] **Step 10: Commit**

```bash
git add denops/@ddu-sources/tgrep/main.ts denops/@ddu-sources/tgrep/main_test.ts
git commit -m "feat(source): add the tgrep ddu source"
```

---

### Task 11: `:DduTgrepStop`

**Files:**
- Modify: `denops/@ddu-sources/tgrep/server.ts`（`stopServer` を追加）
- Modify: `denops/@ddu-sources/tgrep/server_lifecycle_test.ts`
- Create: `denops/ddu-tgrep/main.ts`
- Create: `plugin/ddu_tgrep.vim`
- Create: `autoload/ddu_tgrep.vim`

**Interfaces:**
- Consumes: Task 5 の `serveJsonPath` / `parseServeJson` / `ServerInfo`、Task 7 の `pathExists` / `resolveRootFrom`
- Produces:
  - `function stopServer(root: string): Promise<ServerInfo>`
  - denops プラグイン `ddu-tgrep` の dispatcher `stop(path: unknown): Promise<string>`

**設計上の invariant:** プラグインはサーバーを自動では kill しない。`:DduTgrepStop` だけが serve.json の pid に `SIGTERM` を送る。

- [ ] **Step 1: 失敗するテストを書く**

`server_lifecycle_test.ts` の import に `stopServer` を追加し、末尾に追記する:

```ts
Deno.test("stopServer は serve.json が無ければ throw する", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () => stopServer(root),
      Error,
      "no server info at",
    );
  });
});

Deno.test({
  name: "stopServer は serve.json の pid に SIGTERM を送る",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRoot(async (root) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["eval", "await new Promise((resolve) => setTimeout(resolve, 60_000));"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        await writeServeJson(root, { pid: child.pid, port: 1 });

        const info = await stopServer(root);
        const status = await child.status;

        assertEquals(info.pid, child.pid);
        assertEquals(status.signal, "SIGTERM");
      } finally {
        try {
          child.kill();
        } catch {
          // Already reaped by the assertions above.
        }
      }
    });
  },
});
```

sentinel は 60 秒の `setTimeout` にする。`await new Promise(() => {})` はイベントループに ops が残らないので Deno が `Top-level await promise never resolved` で即座に自死し、`stopServer` の `Deno.kill` が `NotFound` を素で投げる（実測: spawn から 50 ms 以上経つと再現）。`setTimeout` ならタイマーが ops を保持するので確実に生き続ける。テストが途中で落ちた場合に子プロセスを 60 秒残さないよう `finally` で kill する。

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `deno test -A denops/@ddu-sources/tgrep/server_lifecycle_test.ts`
Expected: FAIL（`stopServer` が `server.ts` に無い）

- [ ] **Step 3: `server.ts` に `stopServer` を追加**

ファイル末尾に追加:

```ts
export async function stopServer(root: string): Promise<ServerInfo> {
  const path = serveJsonPath(root);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`tgrep: no server info at ${path}`);
    }
    throw e;
  }

  const info = parseServeJson(text);
  Deno.kill(info.pid, "SIGTERM");
  return info;
}
```

- [ ] **Step 4: テストを走らせて通ることを確認**

Run: `deno test -A denops/@ddu-sources/tgrep/server_lifecycle_test.ts`
Expected: PASS（13 tests。Windows では `spawnServer` の 1 本が ignored）

- [ ] **Step 5: denops プラグインと Vim 側を書く**

`denops/ddu-tgrep/deno.json` は Task 1 で作成済み。以下を追加する。

`denops/ddu-tgrep/main.ts`:

```ts
import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import { pathExists, resolveRootFrom } from "../@ddu-sources/tgrep/root.ts";
import { stopServer } from "../@ddu-sources/tgrep/server.ts";

export function main(denops: Denops): void {
  denops.dispatcher = {
    async stop(path: unknown): Promise<string> {
      if (typeof path !== "string") {
        throw new TypeError(
          `ddu-tgrep: "stop" expects a string path, got ${typeof path}`,
        );
      }

      const root = resolveRootFrom({
        sourcePath: path,
        cwd: await fn.getcwd(denops) as string,
        exists: pathExists,
      });
      const info = await stopServer(root);
      return `ddu-source-tgrep: sent SIGTERM to the tgrep server (root=${root}, pid=${info.pid})`;
    },
  };
}
```

`plugin/ddu_tgrep.vim`:

```vim
if exists('g:loaded_ddu_tgrep')
  finish
endif
let g:loaded_ddu_tgrep = 1

command! -nargs=? -complete=dir DduTgrepStop call ddu_tgrep#stop(<q-args>)
```

`autoload/ddu_tgrep.vim`:

```vim
function! ddu_tgrep#stop(path) abort
  echomsg denops#request('ddu-tgrep', 'stop', [a:path])
endfunction
```

- [ ] **Step 6: 実行時 import が通ることを確認する**

`deno task check` は workspace 設定で解決するので、`denops/ddu-tgrep/deno.json` の import map が不足していても通ってしまう。denops.vim と同じ経路（プラグインの `deno.json` を import map として `ImportMapImporter` に渡す）を再現して、`main.ts` が実際に import できることを確かめる。

一時ファイル `/tmp/ddu-tgrep-import-check.ts` を作る:

```ts
import {
  ImportMapImporter,
  loadImportMap,
} from "jsr:@lambdalisue/import-map-importer@~0.5.1";
import { toFileUrl } from "jsr:@std/path@~1.1.0/to-file-url";

const [entry, importMap] = Deno.args;
const importer = new ImportMapImporter(await loadImportMap(importMap));
const mod = await importer.import<{ main: unknown }>(toFileUrl(entry).href);
console.log("IMPORT OK, exports:", Object.keys(mod));
```

`loadImportMap` は `URL` ではなくパス文字列を取る（内部で `isAbsolute()` に渡す）ので、import map 側だけ `toFileUrl` を通してはいけない。バージョンは denops.vim の `denops/@denops-private/deno.json` と同じ `~0.5.1` に固定する。ここがずれると、検査だけ別バージョンの `loadImportMap` で通って実機で落ちる（あるいはその逆）。

Run:

```bash
deno run -A --no-config /tmp/ddu-tgrep-import-check.ts \
  "$PWD/denops/ddu-tgrep/main.ts" "$PWD/denops/ddu-tgrep/deno.json"
```

Expected: `IMPORT OK, exports: [ "main" ]`

同じコマンドを `denops/@ddu-sources/tgrep/main.ts` + `denops/@ddu-sources/tgrep/deno.json` に対しても実行する。

Expected: `IMPORT OK, exports: [ "Source" ]`

`Import "@std/path/resolve" not a dependency` のようなエラーが出たら、対象の `deno.json` の imports に不足している bare specifier を足す（Task 1 Step 1 の注を参照）。

- [ ] **Step 7: 検証ゲートを通す**

Run: `deno task check && deno task lint && deno task fmt && deno task test`
Expected: すべて成功（`deno check` が `denops/ddu-tgrep/main.ts` も対象になっていることを出力で確認する）

- [ ] **Step 8: Commit**

```bash
git add denops/@ddu-sources/tgrep/server.ts denops/@ddu-sources/tgrep/server_lifecycle_test.ts denops/ddu-tgrep/main.ts plugin/ddu_tgrep.vim autoload/ddu_tgrep.vim
git commit -m "feat(stop): add :DduTgrepStop to terminate the tgrep server"
```

---

### Task 12: doc と README

**Files:**
- Create: `doc/ddu-source-tgrep.txt`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 10 の `Params`（param 名とデフォルト値はここと一致させる）
- Produces: なし（ドキュメントのみ）

- [ ] **Step 1: `doc/ddu-source-tgrep.txt` を書く**

```
*ddu-source-tgrep.txt*	tgrep source for ddu.vim

CONTENTS					*ddu-source-tgrep-contents*

Introduction    |ddu-source-tgrep-introduction|
Install         |ddu-source-tgrep-install|
Commands        |ddu-source-tgrep-commands|
Examples        |ddu-source-tgrep-examples|
Params          |ddu-source-tgrep-params|
Server          |ddu-source-tgrep-server|


==============================================================================
INTRODUCTION					*ddu-source-tgrep-introduction*

This source collects "tgrep" search results.

"tgrep" keeps a trigram index in a background server and answers queries over
TCP, so this source talks to that server instead of spawning a process per
keystroke.  That makes it suited to live grep.

==============================================================================
INSTALL						*ddu-source-tgrep-install*

Please install below plugins.

https://github.com/Shougo/ddu.vim
https://github.com/vim-denops/denops.vim

And install below binary.
https://github.com/microsoft/tgrep

==============================================================================
COMMANDS					*ddu-source-tgrep-commands*

						*:DduTgrepStop*
:DduTgrepStop [{path}]
	Send SIGTERM to the "tgrep" server that serves {path}.
	If {path} is omitted, the server root is resolved from the current
	directory the same way the source resolves it.

	This plugin never stops the server on its own.  The server outlives
	Vim so that the next session reuses the warm index.

==============================================================================
EXAMPLES					*ddu-source-tgrep-examples*

>vim
    " live grep
    " You need to make "volatile" option v:true.
    " Note: the matchers should be empty for performance
    command! DduTgrepLive call <SID>ddu_tgrep_live()
    function! s:ddu_tgrep_live() abort
      call ddu#start(#{
            \   sources: [#{
            \     name: 'tgrep',
            \     options: #{
            \       matchers: [],
            \       volatile: v:true,
            \     },
            \   }],
            \   uiParams: #{
            \     ff: #{
            \       ignoreEmpty: v:false,
            \       autoResize: v:false,
            \     }
            \   },
            \ })
    endfunction

    " Search for a fixed pattern, then filter the results.
    nnoremap <space>/
      \ <Cmd>call ddu#start(#{
      \   sources: [#{
      \     name: 'tgrep',
      \   }],
      \   sourceParams: #{
      \     tgrep: #{
      \       input: input('Pattern: '),
      \     },
      \   },
      \ })<CR>

    " Narrow the search down to the nearest project directory.
    call ddu#custom#patch_global(#{
        \   sourceParams: #{
        \     tgrep: #{
        \       scope: 'marker',
        \       rootMarkers: ['deno.json', 'Cargo.toml'],
        \     },
        \   },
        \ })

    " Change the server root.
    call ddu#start(#{
        \   sources: [#{
        \     name: 'tgrep',
        \     options: #{ path: expand('~/src/project') },
        \   }],
        \ })
<
==============================================================================
PARAMS						*ddu-source-tgrep-params*

						*ddu-source-tgrep-param-cmd*
cmd		(string)
	Executable used to start the server ("{cmd} serve {root}").

	Default: "tgrep"

						*ddu-source-tgrep-param-input*
input		(string)
	Search input string.
	Note: If |ddu-source-option-volatile| is true, |ddu-option-input| is
	used instead.

	Default: ""

					*ddu-source-tgrep-param-scope*
scope		(string)
	Which part of the server root is searched.

	"all"		The whole server root.

	"cwd"		The current directory and below.

	"marker"	The nearest directory at or above the current
			directory that contains one of |ddu-source-tgrep-param-rootMarkers|.
			If none is found, an error is shown; the search is
			not widened to "all".

	Default: "all"

					*ddu-source-tgrep-param-rootMarkers*
rootMarkers	(string[])
	File names looked up when |ddu-source-tgrep-param-scope| is "marker".

	Default: ["package.json", "deno.json", "Cargo.toml", "go.mod",
	"pyproject.toml"]

						*ddu-source-tgrep-param-globs*
globs		(string[])
	Extra path globs.  A leading "!" excludes.

	Including globs are interpreted relative to the directory selected by
	|ddu-source-tgrep-param-scope|, and match at any depth below it.  With
	scope "cwd" in "src/app", "*.ts" searches "src/app/**/*.ts".  With
	scope "all" they are used as they are.

	Excluding globs ("!" prefixed) are passed through unchanged.  They do
	not need the scope prefix, because the including globs already keep
	the search inside the scope.

	Note the asymmetry: an excluding glob is resolved against the server
	root, not against the scope.  tgrep prepends "**/" only to a pattern
	that contains no "/", so "!*_test.ts" excludes matches at any depth,
	while "!vendor/**" excludes only the "vendor" directory directly
	below the server root.  To exclude a directory inside the scope,
	write its full path from the server root: "!src/app/vendor/**".

	Default: []

					*ddu-source-tgrep-param-caseMode*
caseMode	(string)
	How letter case is handled.

	"smart"		Case insensitive unless the input contains an
			uppercase letter.  The whole input string is
			inspected, regular expression metacharacters
			included, so a pattern such as "\S" or "\B" counts
			as containing an uppercase letter and is searched
			case sensitively.

	"sensitive"	Always case sensitive.

	"insensitive"	Always case insensitive.

	Default: "smart"

					*ddu-source-tgrep-param-fixedString*
fixedString	(boolean)
	Treat the input as a literal string instead of a regular expression.

	Default: false

						*ddu-source-tgrep-param-types*
types		(string[])
	ripgrep compatible file type filters ("-t" equivalent).

	Default: []

					*ddu-source-tgrep-param-maxItems*
maxItems	(number)
	Maximum number of items produced from one search.  Extra matches are
	dropped on the client side.

	Default: 10000

					*ddu-source-tgrep-param-minInputLength*
minInputLength	(number)
	Inputs shorter than this are not searched at all.

	Default: 2

					*ddu-source-tgrep-param-highlights*
highlights	(dictionary)
	Highlight groups for "path", "lineNr" and "word".  An empty string
	disables that highlight.

	Default: #{ path: "Normal", lineNr: "Normal", word: "Search" }

					*ddu-source-tgrep-param-serveArgs*
serveArgs	(string[])
	Extra arguments appended to "{cmd} serve {root}", such as
	["--no-watch"].

	Default: []

						*ddu-source-tgrep-param-debug*
debug		(boolean)
	Write diagnostics to |:messages|: how the server was resolved
	(reused or spawned, serve.json path, port, root, full command line,
	whether "setsid" was used, and anything the server wrote to its
	standard error while starting), and for each search the pattern, the
	globs, the resolved case mode, the number of items, the elapsed time
	and whether the response was discarded as stale.

	Default: false

==============================================================================
SERVER						*ddu-source-tgrep-server*

The server root is |ddu-source-option-path| when set, otherwise the nearest
ancestor of the current directory that contains ".git", otherwise the current
directory.

On the first search of a ddu session the source reads "{root}/.tgrep/serve.json"
and reuses the server recorded there when its process is alive and its port
accepts connections.  Otherwise it starts "{cmd} serve {root}" and waits for
serve.json to appear.

The spawned server is always detached with unref() so that it outlives Vim.
How far it is detached depends on the system:

- When "setsid" is on $PATH, the server is started as "setsid {cmd} serve
  {root}" and runs in a process group of its own.
- Otherwise unref() is all there is.  Deno offers no way to put a child in
  its own process group, so a signal sent to Vim's whole process group
  (Ctrl-C in a terminal Vim, for instance) also reaches the server, and the
  server dies with Vim.

|ddu-source-tgrep-param-debug| reports which of the two was used.  Use
|:DduTgrepStop| to stop the server deliberately.

If "tgrep" is missing, the server fails to start, or the connection cannot be
established, the error is reported and the search returns nothing.  This source
never falls back to a serverless search.

Because a live grep runs one search per keystroke, an error message is shown
only once per message text.  The record is cleared every time the source is
initialized, that is, on every |ddu#start()|.

==============================================================================
vim:tw=78:ts=8:ft=help:norl:noet:fen:noet:
```

- [ ] **Step 2: `README.md` を書く**

````markdown
# ddu-source-tgrep

[tgrep](https://github.com/microsoft/tgrep) source for [ddu.vim](https://github.com/Shougo/ddu.vim).

tgrep keeps a trigram index in a background server and answers queries over
TCP JSON-RPC, so this source sends one request per keystroke instead of
spawning a process. That makes it suited to live grep.

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddu.vim

https://github.com/Shougo/ddu.vim

### tgrep

https://github.com/microsoft/tgrep

```console
$ cargo install --git https://github.com/microsoft/tgrep tgrep-cli
```

## Configuration

```vim
call ddu#custom#patch_global(#{
    \   sourceParams: #{
    \     tgrep: #{
    \       caseMode: 'smart',
    \       scope: 'all',
    \     },
    \   },
    \ })
```

Live grep:

```vim
command! DduTgrepLive call s:ddu_tgrep_live()
function! s:ddu_tgrep_live() abort
  call ddu#start(#{
        \   sources: [#{
        \     name: 'tgrep',
        \     options: #{ matchers: [], volatile: v:true },
        \   }],
        \   uiParams: #{
        \     ff: #{ ignoreEmpty: v:false, autoResize: v:false },
        \   },
        \ })
endfunction
```

## Server lifecycle

The source starts `tgrep serve <root>` on demand and leaves it running after
Vim exits so the next session reuses the warm index. Stop it with
`:DduTgrepStop`.

When `setsid` is available the server gets a process group of its own.
Without it, a signal sent to Vim's process group — Ctrl-C in a terminal Vim,
for one — reaches the server too, and it will not survive Vim.

See `:help ddu-source-tgrep` for every parameter.
````

- [ ] **Step 3: doc の param 名がコードと一致することを確認**

Run: `grep -o 'ddu-source-tgrep-param-[a-zA-Z]*' doc/ddu-source-tgrep.txt | sort -u`
Expected: `cmd` / `input` / `scope` / `rootMarkers` / `globs` / `caseMode` / `fixedString` / `types` / `maxItems` / `minInputLength` / `highlights` / `serveArgs` / `debug` の 13 個が並ぶ。`denops/@ddu-sources/tgrep/main.ts` の `params()` が返すキーと過不足なく一致していることを目視で確認する。

- [ ] **Step 4: Commit**

```bash
git add doc/ddu-source-tgrep.txt README.md
git commit -m "docs: add help file and README"
```

---

### Task 13: 実機検証 【ユーザー承認待ち — 着手前に必ず確認を取る】

このタスクは tgrep バイナリをローカルにインストールし、実際に Vim を起動して動作を確認する。**インストールと実行はユーザー環境を変えるので、着手する前にユーザーの承認を得ること。** 承認が無い間は Task 12 までで停止し、状況を報告する。

**Files:**
- Modify: なし（不具合が見つかった場合のみ、該当タスクの形式で TDD サイクルを回して修正する）

**Interfaces:**
- Consumes: Task 1-12 の成果すべて
- Produces: なし

- [ ] **Step 1: 承認を取る**

ユーザーに以下を提示して承認を得る。

- `cargo install --git https://github.com/microsoft/tgrep tgrep-cli` を実行してよいか（あるいは GitHub Releases のバイナリを使うか）
- 検証に使うリポジトリはどこか

- [ ] **Step 2: tgrep をインストールして起動を確認**

Run: `tgrep --version`
Expected: バージョンが表示される

- [ ] **Step 3: サーバーを手で起動して RPC が通ることを確認**

```bash
cd <検証対象リポジトリ>
tgrep serve . &
sleep 3
cat .tgrep/serve.json
PORT=$(deno eval 'console.log(JSON.parse(Deno.readTextFileSync(".tgrep/serve.json")).port)')
printf '%s\n' '{"jsonrpc":"2.0","method":"search","params":{"pattern":"fn ","detail":true,"positions":false},"id":1}' \
  | timeout 10 nc 127.0.0.1 "$PORT" | head -c 400
```

Expected: `{"jsonrpc":"2.0","result":{"matches":[...],"num_matches":...,"elapsed_ms":...},"id":1}` が返る

- [ ] **Step 4: 上で起動したサーバーを止める**

```bash
kill "$(deno eval 'console.log(JSON.parse(Deno.readTextFileSync(".tgrep/serve.json")).pid)')"
```

- [ ] **Step 5: Vim から live grep を動かす**

`&runtimepath` にこのリポジトリを追加した状態で Vim を起動し、Task 12 の `DduTgrepLive` を定義して実行する。確認する項目:

1. 初回の `ddu#start` でサーバーが自動起動し、UI 表示前に待たされること
2. 打鍵ごとに結果が更新されること（`minInputLength` 未満では検索されないこと）
3. path / 行番号 / マッチ語のハイライトが正しい位置に出ること（マルチバイトを含む行で列がずれないこと）
4. 未完成の正規表現（`foo(` など）を打っても `:messages` にエラーが出ず、結果が空になること
5. 存在しない `cmd`（`sourceParams.tgrep.cmd = 'tgrep-not-installed'`）で、`SPAWN_TIMEOUT_MS`（10 秒）待たされずに即座にエラーが表示されること
6. `scope: 'marker'` で marker の無い場所からエラーが出ること。かつ、打鍵を重ねても同じエラーが 1 回しか出ないこと（`ddu#start` をやり直すとまた 1 回出ること）
7. `debug: v:true` で `:messages` にサーバー解決と各検索のログが出ること（`detached=true/false` と、spawn 時の stderr が載ること）
8. `:DduTgrepStop` でサーバーが止まり、`.tgrep/serve.json` の pid が消えること
9. Vim を終了してもサーバーが残り、再起動後の初回検索が速いこと。`setsid` のある環境では端末 Vim で Ctrl-C を打ってもサーバーが生き残ること
10. `scope: 'cwd'` と `globs: ['*.ts']` を併用したとき、cwd 配下の `.ts` だけがヒットして root 全体の `.ts` が出ないこと
11. `:DduTgrepStop` が実行時 import エラーを出さずに動くこと（Task 11 Step 6 の smoke import と別に、実機でも 1 回確認する）
12. `!` 付きの exclude が doc の説明どおりに効くこと。`scope: 'cwd'` で root 直下ではないディレクトリ（例 `src/app`）にいる状態で、`globs: ['!*_test.ts']` は `src/app` 配下の任意の深さの `*_test.ts` を落とし、`globs: ['!vendor/**']` は `src/app/vendor/**` を落とさない（`!src/app/vendor/**` と server root からのフルパスで書けば落ちる）こと

- [ ] **Step 6: 見つかった不具合を報告する**

不具合があれば、修正に入る前にユーザーに一覧を提示して、本ブランチで直すか別 issue にするかの判断を仰ぐ。

---

## Self-Review 結果

**1. Spec coverage**

| spec の項目 | 対応タスク |
|---|---|
| ファイル構成（main / server / rpc / deno.json / deno.jsonc / plugin / autoload / doc） | Task 1, 2, 3, 5, 6, 10, 11, 12 |
| root の決定（sourceOptions.path → git root → cwd） | Task 7 |
| サーバー検出（serve.json + pid 生存 + TCP 接続） | Task 6 |
| detached spawn（`setsid` があればプロセスグループ分離、無ければ `unref` のみ）+ 起動ポーリング | Task 6、制約は Task 12 の doc |
| flock で先を越された場合の接続切替 | Task 6（ポーリングが勝者の serve.json を拾う）。起動後の失敗は stderr を timeout エラーと debug に載せる |
| 起動タイミングは onInit | Task 10 |
| プラグインは kill しない / `:DduTgrepStop` が SIGTERM | Task 11 |
| 接続断で再接続 1 回 | Task 3 |
| scope all / cwd / marker と root 相対 glob | Task 8 |
| `globs` の include を scope 相対で AND 合成（`combineGlobs`） | Task 8、doc は Task 12 |
| marker が無ければエラー（all に広げない） | Task 8 |
| volatile による入力の切り替え | Task 10 |
| minInputLength 未満で close | Task 10 |
| caseMode smart のクライアント側変換 | Task 9, 10 |
| 2 段チャンク enqueue | Task 10 |
| id 採番と stale レスポンス破棄 / ソケット使い回し | Task 2, 3, 10 |
| maxItems のクライアント側打ち切り | Task 9 |
| item 生成（word / action.col は `columns` / ハイライトは `spans` / UTF-8 バイト長） | Task 9 |
| source params 13 個 | Task 10（`params()`）, Task 12（doc） |
| debug 出力（サーバー解決の経緯 / 各 search の概要と結果） | Task 4, 6, 10 |
| fail-loud、regex 構文エラーのみ握り潰し | Task 10（`isRegexSyntaxError` は Task 1） |
| 同一エラーメッセージは 1 回だけ表示、`onInit` でリセット | Task 10（`#reportOnce`） |
| `onInit` の再入で旧 session を close | Task 10 |
| 検証方針（check / lint / fmt / test、純ロジック中心の unit test） | 全タスクの検証ゲート |
| 実機検証には tgrep のインストールが必要 | Task 13 |
| 初版で見送るもの（category / migemo / status・reload） | どのタスクにも入れていない |

ギャップなし。

**2. Placeholder scan**

「TBD」「後で」「適切に」「Task N と同様」に相当する記述なし。全ステップに実コードまたは実行コマンドと期待値が入っている。Task 13 だけは実機操作なのでコード生成が無いが、実行コマンドと確認項目を具体化してある。

**3. Type consistency**

- `RpcSession.call(method, params, signal?)` — Task 3 の定義と Task 10 の呼び出しで一致。
- `startFakeServer` の `handle` は `void | Promise<void>` を返す — Task 2 の定義と、Task 2 / Task 3 / Task 10 の非 async ハンドラの両方に適合する。
- `SpawnResult = { commandLine, detached, stderr }` — Task 6 の `spawnServer` の戻り値、`ensureServer` の `spawn` 引数、Task 6 テストの `fakeSpawn`、Task 10 の `SourceDeps.spawn` の 4 か所で一致。
- `EnsureServerArgs = { cmd, root, serveArgs, debug, spawn, timeoutMs }` — Task 6 で定義し、Task 6 テスト・Task 10 の `SourceDeps.ensureServer` の型・Task 10 の呼び出しで一致。
- `resolveScope` は `string`（root 相対パス、root 全体なら `""`）を返す — Task 8 の定義、Task 8 のテスト、Task 10 の `combineGlobs` への受け渡しで一致。`scopeGlobs`（`string[]` を返す旧名）はもう存在しない。
- `combineGlobs(prefix: string, globs: string[]): string[]` — Task 8 の定義と Task 10 の呼び出しで一致。戻り値がそのまま RPC の `glob` に載る。
- `matchRowsToItems` の引数 `{ rows, root, highlights, maxItems }` — Task 9 の定義と Task 10 の呼び出しで一致。
- match 行の必須フィールドは `type` / `file` / `line` / `content` / `spans` / `columns` — Task 9 の実装と、Task 9 / Task 10 のテストデータで一致（`columns` を持たない fixture は「throw する」テストだけ）。
- `parseSearchResult` の戻り値は camelCase（`numMatches` / `elapsedMs`）で、Task 10 のデバッグ出力もそれを使っている。
- `HighlightGroup` は Task 9 で定義し Task 10 の `Params` が再利用。`CaseMode` / `Scope` も同様。
- `DebugLogger` は Task 4 で定義し Task 6 / Task 10 が消費。
- `pathExists` / `resolveRootFrom` は Task 7 で定義し Task 10 と Task 11 が消費。Task 6 の `setsid` 探索と `cmd` の存在確認は `pathExists` を使わず `server.ts` 内の `isExecutableInPath` / `commandExists` で完結させている（PATH 上の読めないディレクトリは「無い」として次へ進むべきで、非 NotFound を rethrow する `pathExists` とは要件が違うため。Task 6 が Task 7 に依存しないという副次効果もある）。
- `Source` のコンストラクタは `deps` を省略できる — ddu の loader は `new Source()` で生成するので必須。

**4. lint（`require-await` / `no-unused-vars` / `camelcase`）の机上確認**

- 非 async にしたのは `startFakeServer` / Task 2 の abort テストのハンドラ / Task 3 の 3 番目のテストのハンドラの 3 か所。いずれも本体に `await` が無かったもので、`handle` の戻り型を緩めたことで型は通る。
- 新規に足した非 async 関数（`fakeSpawn` / `isExecutableInPath` / `commandExists` / `#reportOnce` / `reportKey` / `sourceOn` / `closeSource` / `onInitArgs` / `gatherArgs` / `stubDenops`）はどれも `async` を付けていない。Task 6 の `spawnServer` テストは `Deno.test({ name, ignore, fn })` の同期 `fn` なのでこれも該当しない。
- `spawnServer` の stderr 読み捨てタスクは `for await` を含むので `require-await` に触れない。
- Task 10 のテストから `RpcSession` の import を落とした（DI 化で不要になったため）。Task 6 のテストは `SpawnArgs` / `SpawnResult` / `spawnServer` と `assertThrows` を使う（いずれも使用箇所あり）。
- 追加した識別子はすべて camelCase（`callArgs` 等）。snake_case が出るのは JSON-RPC の payload のキーだけで、これは変更前から同じ。

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

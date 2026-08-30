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

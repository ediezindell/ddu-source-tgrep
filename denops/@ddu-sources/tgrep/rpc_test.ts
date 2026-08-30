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
  const line =
    '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}';

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
    isRegexSyntaxError({
      code: -32602,
      message: "regex error: unclosed group",
    }),
    true,
  );
  assertEquals(
    isRegexSyntaxError({ code: -32602, message: "unknown encoding: sjis" }),
    false,
  );
  assertEquals(
    isRegexSyntaxError({
      code: -32603,
      message: "regex error: unclosed group",
    }),
    false,
  );
});

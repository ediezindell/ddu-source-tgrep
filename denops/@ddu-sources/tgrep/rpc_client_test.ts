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
    await write(
      JSON.stringify({ jsonrpc: "2.0", result: "fresh", id: request.id }),
    );
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

  const pending = client.call(
    "search",
    { pattern: "gamma" },
    controller.signal,
  );
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

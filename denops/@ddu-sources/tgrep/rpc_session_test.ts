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

  assertEquals(
    await session.call("search", { pattern: "first" }),
    "reconnected",
  );
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

Deno.test("切断後に2つの call を同時に投げても接続は1本しか張られない", async () => {
  const server = await startFakeServer(async (request, write) => {
    await write(
      JSON.stringify({ jsonrpc: "2.0", result: request.id, id: request.id }),
    );
  });
  const session = new RpcSession(server.port);

  await session.call("search", { pattern: "warmup" });
  assertEquals(server.connectionCount, 1);

  server.dropConnections();
  await new Promise((resolve) => setTimeout(resolve, 50));

  await Promise.all([
    session.call("search", { pattern: "one" }),
    session.call("search", { pattern: "two" }),
  ]);

  assertEquals(server.connectionCount, 2);

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

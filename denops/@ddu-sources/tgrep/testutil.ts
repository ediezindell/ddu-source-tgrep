import { TextLineStream } from "@std/streams/text-line-stream";

export type FakeServer = {
  port: number;
  requests: Record<string, unknown>[];
  connectionCount: number;
  dropConnections: () => void;
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
  const state = { connectionCount: 0 };

  const accepting = (async () => {
    for await (const conn of listener) {
      state.connectionCount++;
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
    get connectionCount() {
      return state.connectionCount;
    },
    dropConnections: () => {
      for (const conn of conns) {
        try {
          conn.close();
        } catch {
          // Already closed by the client side.
        }
      }
    },
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

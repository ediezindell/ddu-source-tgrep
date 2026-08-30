import { abortable } from "@std/async/abortable";
import { TextLineStream } from "@std/streams/text-line-stream";

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
    this.#fail(
      new RpcConnectionError("tgrep: connection closed by the client"),
    );
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
          `tgrep: connection error: ${
            e instanceof Error ? e.message : String(e)
          }`,
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

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

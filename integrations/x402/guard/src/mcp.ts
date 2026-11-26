import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProkuraGrantError, ProkuraTransportError } from "./errors.ts";

export const DEFAULT_ENDPOINT = "https://prokura.network/mcp";

export const TOOLS = {
  check: "prokura_check",
  pay: "prokura_pay",
  requestMandate: "prokura_request_mandate",
  evidence: "prokura_evidence",
} as const;

/** The result of an MCP tools/call, as far as I read it. */
export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

/**
 * The one thing the guard needs from MCP. Bring your own (tests, a different
 * transport) or use connectProkura().
 */
export interface ProkuraMcp {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close?(): Promise<void>;
}

/** Adapt a connected @modelcontextprotocol/sdk Client. */
export function fromMcpClient(client: Client): ProkuraMcp {
  return {
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    },
    close: () => client.close(),
  };
}

export interface ConnectOptions {
  /** MCP endpoint. Default https://prokura.network/mcp, or PROKURA_MCP_URL. */
  url?: string;
  clientName?: string;
}

/** Open one Streamable HTTP session. The session holds the demo grant, so keep it for the agent's lifetime. */
export async function connectProkura(opts: ConnectOptions = {}): Promise<ProkuraMcp> {
  const url = opts.url ?? process.env.PROKURA_MCP_URL ?? DEFAULT_ENDPOINT;
  const client = new Client({ name: opts.clientName ?? "prokura-x402-guard", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return fromMcpClient(client);
}

const GRANT_CODES = new Set(["grant_required", "grant_pending", "grant_expired", "mandate_not_in_session"]);

/** Structured content of a tool result, or a typed error. */
export function readToolResult(res: ToolResult): Record<string, unknown> {
  const body = res.structuredContent ?? parseText(res);
  if (res.isError) {
    const code = typeof body?.error === "string" ? body.error : undefined;
    const message =
      (typeof body?.message === "string" && body.message) ||
      res.content?.find((c) => c.type === "text")?.text ||
      "tool call failed";
    if (code && GRANT_CODES.has(code))
      throw new ProkuraGrantError(code, message, typeof body?.grantUrl === "string" ? body.grantUrl : undefined);
    throw new ProkuraTransportError(code ? `${code}: ${message}` : message);
  }
  if (!body) throw new ProkuraTransportError("the tool answered without structured content");
  return body;
}

function parseText(res: ToolResult): Record<string, unknown> | undefined {
  const text = res.content?.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask for a demo mandate in this session. While it is pending, a human
 * approves it at grantUrl; once granted, the answer carries the mandateId.
 */
export async function requestMandate(
  mcp: ProkuraMcp,
  agentName?: string,
): Promise<{ status: string; grantUrl?: string; expiresAt?: string; mandateId?: string }> {
  const b = readToolResult(await mcp.callTool(TOOLS.requestMandate, agentName ? { agent_name: agentName } : {}));
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  return {
    status: str("status") ?? "unknown",
    grantUrl: str("grantUrl"),
    expiresAt: str("expiresAt"),
    mandateId: str("mandateId"),
  };
}

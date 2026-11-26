// Shared helper: ask the Prokura gate over MCP. Needs an MCP session that already
// holds a granted mandate (in the public demo: prokura_request_mandate, then a human
// opens the grant URL). Without one the server answers grant_required / grant_pending
// and does not call the gate, so treat anything but a decision as "do not pay".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type Decision = { decision: "allow" | "step_up" | "deny"; reasons: string[]; raw: unknown };

export interface CheckInput {
  amount: string;                       // "12.00": two decimals, as the schema requires
  currency: string;                     // e.g. "EUR", "USDC"
  payee: { type: "domain" | "iban"; value: string; name?: string };
  purpose: string;                      // a purpose code allowed by the mandate
  rail?: string;                        // e.g. "mollie", "x402"
  reference?: Record<string, unknown>;
  agent_name?: string;
}

export async function prokuraCheck(client: Client, input: CheckInput): Promise<Decision | { error: string; raw: unknown }> {
  const res: any = await client.callTool({ name: "prokura_check", arguments: { ...input } });
  const data = res.structuredContent ?? safeJson(res.content?.find((c: any) => c.type === "text")?.text);
  if (res.isError || !data?.decision) return { error: data?.error ?? "no_decision", raw: data };
  return { decision: data.decision, reasons: data.reasons ?? [], raw: data };
}

function safeJson(s: unknown) {
  try { return typeof s === "string" ? JSON.parse(s) : undefined; } catch { return undefined; }
}

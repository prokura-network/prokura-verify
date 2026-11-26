import { ProkuraDeniedError, ProkuraStepUpError } from "./errors.ts";
import { toReceipt } from "./guard.ts";
import { type ProkuraMcp, readToolResult, TOOLS } from "./mcp.ts";
import type { ProkuraReceipt } from "./types.ts";

export interface PayOptions {
  mcp: ProkuraMcp;
  /** Purpose code. Default (server side) "api_usage". */
  purpose?: string;
  /** If given, it must equal the challenge price; Prokura refuses otherwise. */
  amount?: string;
  mandateId?: string;
  agentName?: string;
  item?: string;
  /**
   * What to do on step_up. "throw" (default) throws ProkuraStepUpError with
   * approvalUrl; "return" returns the result so you can show the link.
   */
  onStepUp?: "throw" | "return";
}

export interface PayResult {
  receipt: ProkuraReceipt;
  /** Only on step_up. */
  approvalUrl?: string;
  /** What the rail did (allow only). `response` is the paid body for x402. */
  execution?: {
    rail?: string;
    railRef?: string;
    railStatus?: string;
    error?: string;
    response?: { status: number; contentType?: string; body: string };
  };
}

/**
 * Let Prokura pay an HTTP 402 resource (prokura_pay with x402Url). Prokura
 * reads the challenge, decides, and on allow pays from its own x402 rail and
 * returns the paid response. Your agent holds no wallet in this mode.
 */
export async function prokuraPay(url: string, opts: PayOptions): Promise<PayResult> {
  const args: Record<string, unknown> = { x402Url: url };
  if (opts.purpose) args.purpose = opts.purpose;
  if (opts.amount) args.amount = opts.amount;
  if (opts.mandateId) args.mandateId = opts.mandateId;
  if (opts.agentName) args.agent_name = opts.agentName.slice(0, 64);
  if (opts.item) args.reference = { item: opts.item.slice(0, 64) };
  const body = readToolResult(await opts.mcp.callTool(TOOLS.pay, args));
  const receipt = toReceipt(body);
  if (receipt.decision === "deny") throw new ProkuraDeniedError(receipt);
  if (receipt.decision === "step_up") {
    if (opts.onStepUp !== "return") throw new ProkuraStepUpError(receipt);
    return { receipt, approvalUrl: receipt.stepUp?.url };
  }
  const result: PayResult = { receipt };
  if (body.execution && typeof body.execution === "object") result.execution = body.execution as PayResult["execution"];
  return result;
}

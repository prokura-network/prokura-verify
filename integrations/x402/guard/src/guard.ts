import { AsyncLocalStorage } from "node:async_hooks";
import { ProkuraDeniedError, ProkuraGuardError, ProkuraStepUpError, ProkuraTransportError } from "./errors.ts";
import { type MappingOptions, requirementToIntent } from "./mapping.ts";
import { type ProkuraMcp, readToolResult, TOOLS } from "./mcp.ts";
import type {
  Decision,
  ProkuraReceipt,
  X402PaymentCreationContext,
  X402PaymentRequired,
  X402Requirement,
} from "./types.ts";

export interface GuardOptions extends MappingOptions {
  /** MCP connection to Prokura (connectProkura() or your own). */
  mcp: ProkuraMcp;
  /** Called with every receipt, including deny and step_up. */
  onDecision?: (receipt: ProkuraReceipt) => void;
}

/** Anything with the @x402/core x402Client hook registration. */
export interface HookableX402Client {
  onBeforePaymentCreation(
    hook: (ctx: X402PaymentCreationContext) => Promise<void | { abort: true; reason: string }>,
  ): unknown;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CallState {
  requestUrl?: string;
  receipt?: ProkuraReceipt;
  error?: unknown;
}

const DECISIONS = new Set<Decision>(["allow", "step_up", "deny"]);

/** Read a prokura_check / prokura_pay answer into a receipt. */
export function toReceipt(body: Record<string, unknown>, intent?: ProkuraReceipt["intent"]): ProkuraReceipt {
  const decision = body.decision as Decision;
  if (!DECISIONS.has(decision)) throw new ProkuraTransportError(`unexpected decision ${String(body.decision)}`);
  if (typeof body.evidenceId !== "string") throw new ProkuraTransportError("the answer carries no evidenceId");
  const receipt: ProkuraReceipt = {
    decision,
    reasons: Array.isArray(body.reasons) ? body.reasons.map(String) : [],
    evidenceId: body.evidenceId,
  };
  if (intent) receipt.intent = intent;
  const s = body.stepUp as { url?: unknown; expiresAt?: unknown } | undefined;
  if (s && typeof s.url === "string")
    receipt.stepUp = { url: s.url, ...(typeof s.expiresAt === "string" ? { expiresAt: s.expiresAt } : {}) };
  return receipt;
}

export class ProkuraGuard {
  private readonly calls = new AsyncLocalStorage<CallState>();
  private readonly receipts = new WeakMap<Response, ProkuraReceipt>();
  /** x402 re-creates the payload after a recoverable failure; I reuse the decision for the same challenge. */
  private readonly decided = new WeakMap<object, ProkuraReceipt>();

  constructor(private readonly opts: GuardOptions) {}

  /** Ask the gate, never throw on a decision. Throws only on mapping, grant or transport problems. */
  async decide(
    paymentRequired: X402PaymentRequired,
    requirement: X402Requirement,
    requestUrl?: string,
  ): Promise<ProkuraReceipt> {
    const intent = requirementToIntent(paymentRequired, requirement, this.opts, requestUrl);
    const res = await this.opts.mcp.callTool(TOOLS.check, { ...intent });
    const receipt = toReceipt(readToolResult(res), intent);
    this.opts.onDecision?.(receipt);
    return receipt;
  }

  /** Ask the gate and throw unless it said allow. Returns the allow receipt. */
  async check(
    paymentRequired: X402PaymentRequired,
    requirement: X402Requirement,
    requestUrl?: string,
  ): Promise<ProkuraReceipt> {
    const receipt = await this.decide(paymentRequired, requirement, requestUrl);
    if (receipt.decision === "deny") throw new ProkuraDeniedError(receipt);
    if (receipt.decision === "step_up") throw new ProkuraStepUpError(receipt);
    return receipt;
  }

  /**
   * An @x402/core onBeforePaymentCreation hook. It runs after x402 picked the
   * requirement and before the wallet signs anything; it throws unless the
   * gate said allow.
   */
  readonly beforePaymentCreation = async (ctx: X402PaymentCreationContext): Promise<void> => {
    const state = this.calls.getStore();
    const key = ctx.paymentRequired as object;
    let receipt = this.decided.get(key);
    try {
      if (!receipt || receipt.decision !== "allow") {
        receipt = await this.check(ctx.paymentRequired, ctx.selectedRequirements, state?.requestUrl);
        this.decided.set(key, receipt);
      }
      if (state) state.receipt = receipt;
    } catch (err) {
      if (state) state.error = err;
      throw err;
    }
  };

  /** Register the hook on an x402Client (from @x402/fetch or @x402/core/client). */
  protect<C extends HookableX402Client>(client: C): C {
    client.onBeforePaymentCreation(this.beforePaymentCreation);
    return client;
  }

  /**
   * Wrap a payment-enabled fetch (wrapFetchWithPayment(fetch, protectedClient)).
   * x402 wraps hook errors in a plain Error; I rethrow the typed Prokura error
   * instead, and remember the receipt of every paid response (receiptOf()).
   */
  wrapFetch(fetchWithPayment: FetchLike): FetchLike {
    return (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const state: CallState = { requestUrl };
      return this.calls.run(state, async () => {
        let response: Response;
        try {
          response = await fetchWithPayment(input, init);
        } catch (err) {
          if (state.error instanceof ProkuraGuardError) throw state.error;
          throw err;
        }
        if (state.receipt) this.receipts.set(response, state.receipt);
        return response;
      });
    };
  }

  /** The Nachweis receipt of a response from wrapFetch(), or undefined if no payment was needed. */
  receiptOf(response: Response): ProkuraReceipt | undefined {
    return this.receipts.get(response);
  }
}

export function createProkuraGuard(opts: GuardOptions): ProkuraGuard {
  return new ProkuraGuard(opts);
}

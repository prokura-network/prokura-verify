/**
 * The x402 shapes I read. They are structural on purpose: the guard works with
 * @x402/core v2 objects and with v1 challenges (maxAmountRequired, resource on
 * the requirement) without importing either at runtime.
 */
export interface X402Requirement {
  scheme: string;
  network: string;
  asset: string;
  /** v2: atomic amount. */
  amount?: string;
  /** v1: atomic amount. */
  maxAmountRequired?: string;
  /** v1: the paid resource URL. */
  resource?: string;
  description?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  /** v2: the paid resource. */
  resource?: { url: string; description?: string } | string;
  accepts: X402Requirement[];
  extensions?: Record<string, unknown>;
}

/** What @x402/core passes to onBeforePaymentCreation. */
export interface X402PaymentCreationContext {
  paymentRequired: X402PaymentRequired;
  selectedRequirements: X402Requirement;
}

export type Payee = { type: "domain"; value: string };

/** The intent fields I send to prokura_check (mandateId comes from the session). */
export interface ProkuraIntentArgs {
  amount: string;
  currency: string;
  payee: Payee;
  purpose: string;
  rail: "x402";
  reference: { resource: string; description?: string; item?: string };
  mandateId?: string;
  agent_name?: string;
}

export type Decision = "allow" | "step_up" | "deny";

/** The Nachweis receipt of one decision. Every check returns one, also on deny. */
export interface ProkuraReceipt {
  decision: Decision;
  reasons: string[];
  /** Id of the signed Nachweis record (verify it with prokura-verify). */
  evidenceId: string;
  /** The intent I sent (guard mode). In prokuraPay() the server builds it from the challenge. */
  intent?: ProkuraIntentArgs;
  /** Only on step_up, and only when the server sent one (prokura_pay does, prokura_check does not). */
  stepUp?: { url: string; expiresAt?: string };
}

import type { ProkuraReceipt } from "./types.ts";

/** Base class: no payment was made. */
export class ProkuraGuardError extends Error {
  override name = "ProkuraGuardError";
}

/** The gate said deny. `code` is the first reason; `receipt.evidenceId` is the signed record. */
export class ProkuraDeniedError extends ProkuraGuardError {
  override name = "ProkuraDeniedError";
  readonly code: string;
  constructor(readonly receipt: ProkuraReceipt) {
    super(`Prokura denied the payment: ${receipt.reasons.join(", ") || "no reason given"} (Nachweis ${receipt.evidenceId})`);
    this.code = receipt.reasons[0] ?? "DENIED";
  }
  get reasons() {
    return this.receipt.reasons;
  }
  get evidenceId() {
    return this.receipt.evidenceId;
  }
}

/** The gate wants a human to approve. `approvalUrl` is set when the server returned one. */
export class ProkuraStepUpError extends ProkuraGuardError {
  override name = "ProkuraStepUpError";
  constructor(readonly receipt: ProkuraReceipt) {
    super(
      receipt.stepUp
        ? `Prokura needs a human approval: ${receipt.stepUp.url} (Nachweis ${receipt.evidenceId})`
        : `Prokura needs a human approval before this payment (Nachweis ${receipt.evidenceId}). prokura_check returns no approval link; use prokuraPay() to get one.`,
    );
  }
  get approvalUrl() {
    return this.receipt.stepUp?.url;
  }
  get expiresAt() {
    return this.receipt.stepUp?.expiresAt;
  }
  get reasons() {
    return this.receipt.reasons;
  }
  get evidenceId() {
    return this.receipt.evidenceId;
  }
}

/**
 * The MCP session has no usable mandate (grant_required, grant_pending,
 * grant_expired, mandate_not_in_session). The gate was not called, so there is
 * no Nachweis record.
 */
export class ProkuraGrantError extends ProkuraGuardError {
  override name = "ProkuraGrantError";
  constructor(
    readonly code: string,
    message: string,
    readonly grantUrl?: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** The 402 challenge cannot be expressed as a Prokura intent (sub-cent price, unknown asset, IP host, ...). */
export class ProkuraMappingError extends ProkuraGuardError {
  override name = "ProkuraMappingError";
}

/** The MCP call failed or answered something I cannot read. */
export class ProkuraTransportError extends ProkuraGuardError {
  override name = "ProkuraTransportError";
}

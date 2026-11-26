import { ProkuraMappingError } from "./errors.ts";
import type { ProkuraIntentArgs, X402PaymentRequired, X402Requirement } from "./types.ts";

export interface AssetInfo {
  currency: string;
  decimals: number;
}

/**
 * USDC contracts and mints I recognise without configuration. Keys are
 * compared case-insensitively. Add others with the `assets` option.
 */
export const KNOWN_ASSETS: Readonly<Record<string, AssetInfo>> = {
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { currency: "USDC", decimals: 6 },
  // Base Sepolia
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { currency: "USDC", decimals: 6 },
  // Ethereum
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { currency: "USDC", decimals: 6 },
  // Ethereum Sepolia
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { currency: "USDC", decimals: 6 },
  // Polygon
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { currency: "USDC", decimals: 6 },
  // Solana mainnet
  epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v: { currency: "USDC", decimals: 6 },
  // Solana devnet
  "4zmmc9srt5ri5x14gagxhaii3gnpaeerypjgzjdncdu": { currency: "USDC", decimals: 6 },
};

export interface MappingOptions {
  /** Purpose code the mandate allows. Default "api_usage". */
  purpose?: string;
  /**
   * Payee domain. Default: the host of the paid resource. Give a parent domain
   * (or a function of the host) when the mandate lists e.g. "example.com" and
   * the API lives on "api.example.com". It must be the host or a parent of it.
   */
  payeeDomain?: string | ((host: string) => string);
  /** Extra assets by contract or mint address. */
  assets?: Record<string, AssetInfo>;
  /** Short, self-declared label of what is bought (reference.item, at most 64 chars). */
  item?: string;
  /** Mandate id, when the MCP session does not hold one already. */
  mandateId?: string;
  /** Self-declared agent name stored with the evidence (at most 64 chars). */
  agentName?: string;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

/** Atomic units to a two-decimal string. Refuses prices that are not whole cents. */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) throw new ProkuraMappingError(`amount "${atomic}" is not an atomic integer`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new ProkuraMappingError(`asset decimals ${decimals} are not supported`);
  const value = BigInt(atomic);
  let cents: bigint;
  if (decimals >= 2) {
    const per = 10n ** BigInt(decimals - 2);
    if (value % per !== 0n)
      throw new ProkuraMappingError(
        `price ${atomic} (${decimals} decimals) is below one cent or not whole cents; Prokura intents use two decimals`,
      );
    cents = value / per;
  } else {
    cents = value * 10n ** BigInt(2 - decimals);
  }
  if (cents === 0n) throw new ProkuraMappingError("price is zero");
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** The paid resource URL: v2 `paymentRequired.resource.url`, else v1 `requirement.resource`, else the request URL. */
export function resourceUrlOf(pr: X402PaymentRequired, req: X402Requirement, requestUrl?: string): string {
  const r = pr.resource;
  const url = (typeof r === "string" ? r : r?.url) || req.resource || requestUrl;
  if (!url) throw new ProkuraMappingError("the 402 challenge names no resource URL");
  return url;
}

function hostOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ProkuraMappingError(`resource "${url}" is not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new ProkuraMappingError(`resource "${url}" is not http(s)`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!DOMAIN.test(host))
    throw new ProkuraMappingError(`resource host "${host}" is not a domain name; Prokura payees are domains`);
  return host;
}

/**
 * Map one x402 payment requirement to Prokura intent arguments:
 * payee = domain of the resource, amount = price in whole cents,
 * reference.resource = the resource URL, rail = x402.
 */
export function requirementToIntent(
  paymentRequired: X402PaymentRequired,
  requirement: X402Requirement,
  opts: MappingOptions = {},
  requestUrl?: string,
): ProkuraIntentArgs {
  const atomic = requirement.amount ?? requirement.maxAmountRequired;
  if (atomic === undefined) throw new ProkuraMappingError("the requirement has no amount");
  const asset = opts.assets?.[requirement.asset] ?? lookupAsset(requirement.asset, opts.assets);
  if (!asset)
    throw new ProkuraMappingError(
      `asset ${requirement.asset} on ${requirement.network} is unknown; pass it in the assets option`,
    );
  const resource = resourceUrlOf(paymentRequired, requirement, requestUrl);
  const host = hostOf(resource);
  const payee =
    typeof opts.payeeDomain === "function"
      ? opts.payeeDomain(host)
      : (opts.payeeDomain ?? host).toLowerCase();
  if (!DOMAIN.test(payee)) throw new ProkuraMappingError(`payee "${payee}" is not a lower-case domain`);
  if (host !== payee && !host.endsWith(`.${payee}`))
    throw new ProkuraMappingError(`resource host ${host} is not on the payee domain ${payee}`);

  const intent: ProkuraIntentArgs = {
    amount: atomicToDecimal(atomic, asset.decimals),
    currency: asset.currency,
    payee: { type: "domain", value: payee },
    purpose: opts.purpose ?? "api_usage",
    rail: "x402",
    reference: { resource },
  };
  const description =
    (typeof paymentRequired.resource === "object" ? paymentRequired.resource?.description : undefined) ??
    requirement.description;
  if (description) intent.reference.description = description.slice(0, 255);
  if (opts.item) intent.reference.item = opts.item.slice(0, 64);
  if (opts.mandateId) intent.mandateId = opts.mandateId;
  if (opts.agentName) intent.agent_name = opts.agentName.slice(0, 64);
  return intent;
}

function lookupAsset(address: string, extra?: Record<string, AssetInfo>): AssetInfo | undefined {
  const key = address.toLowerCase();
  if (extra) for (const [k, v] of Object.entries(extra)) if (k.toLowerCase() === key) return v;
  return KNOWN_ASSETS[key];
}

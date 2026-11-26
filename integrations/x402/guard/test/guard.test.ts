import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  createProkuraGuard,
  ProkuraDeniedError,
  ProkuraGrantError,
  ProkuraMappingError,
  ProkuraStepUpError,
  type ProkuraReceipt,
} from "../src/index.ts";
import { type Call, challengeV2, EVIDENCE, USDC_BASE_SEPOLIA, mock402Server, mockMcp, ok, refused } from "./helpers.ts";

const URL_PAID = "https://api.weather.example.com/forecast";

/** A wallet stand-in that records every payload it signs. */
function fakeWallet() {
  const signed: PaymentRequirements[] = [];
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    // Like the real EVM scheme: USDC is a default asset, so x402 spend controls accept it.
    findDefaultAsset: (asset) =>
      asset.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() ? { asset, decimals: 6, symbol: "USDC" } : undefined,
    async createPaymentPayload(x402Version, requirements) {
      signed.push(requirements);
      return { x402Version, payload: { signature: "0xfake" } };
    },
  };
  return { scheme, signed };
}

function setup(answer: (call: Call) => ReturnType<typeof ok>, price = "50000") {
  const { mcp, calls } = mockMcp(answer);
  const receipts: ProkuraReceipt[] = [];
  const guard = createProkuraGuard({ mcp, agentName: "weather-bot", onDecision: (r) => receipts.push(r) });
  const wallet = fakeWallet();
  const client = guard.protect(new x402Client().register("eip155:84532", wallet.scheme));
  const server = mock402Server((url) => challengeV2(url, price));
  const fetchPaid = guard.wrapFetch(wrapFetchWithPayment(server.fetch, client));
  return { guard, calls, receipts, wallet, server, fetchPaid };
}

const decision = (d: string, reasons: string[] = [], extra = {}) => ok({ decision: d, reasons, evidenceId: EVIDENCE, ...extra });

test("allow: the intent is checked, then the wallet pays, and the receipt is kept", async () => {
  const t = setup(() => decision("allow"));
  const res = await t.fetchPaid(URL_PAID);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { forecast: "sunny" });

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.name, "prokura_check");
  assert.deepEqual(t.calls[0]!.args, {
    amount: "0.05",
    currency: "USDC",
    payee: { type: "domain", value: "api.weather.example.com" },
    purpose: "api_usage",
    rail: "x402",
    reference: { resource: URL_PAID, description: "Weather forecast" },
    agent_name: "weather-bot",
  });
  assert.equal(t.wallet.signed.length, 1);
  assert.deepEqual(
    t.server.seen.map((s) => s.paid),
    [false, true],
  );
  const receipt = t.guard.receiptOf(res);
  assert.equal(receipt?.decision, "allow");
  assert.equal(receipt?.evidenceId, EVIDENCE);
  assert.equal(t.receipts.length, 1);
});

test("deny: typed error with reason codes and receipt, the wallet never signs", async () => {
  const t = setup(() => decision("deny", ["RAIL_NOT_ALLOWED", "PAYEE_NOT_ALLOWED"]));
  await assert.rejects(t.fetchPaid(URL_PAID), (err: unknown) => {
    assert.ok(err instanceof ProkuraDeniedError);
    assert.equal(err.code, "RAIL_NOT_ALLOWED");
    assert.deepEqual(err.reasons, ["RAIL_NOT_ALLOWED", "PAYEE_NOT_ALLOWED"]);
    assert.equal(err.evidenceId, EVIDENCE);
    return true;
  });
  assert.equal(t.wallet.signed.length, 0);
  assert.ok(t.server.seen.every((s) => !s.paid));
  assert.equal(t.receipts[0]?.decision, "deny");
});

test("step_up: typed error, approval URL when the server sends one, no payment", async () => {
  const withUrl = setup(() =>
    decision("step_up", ["STEP_UP_REQUIRED"], {
      stepUp: { url: "https://approve.prokura.network/a/abc", expiresAt: "2026-11-26T12:15:00Z" },
    }),
  );
  await assert.rejects(withUrl.fetchPaid(URL_PAID), (err: unknown) => {
    assert.ok(err instanceof ProkuraStepUpError);
    assert.equal(err.approvalUrl, "https://approve.prokura.network/a/abc");
    assert.equal(err.expiresAt, "2026-11-26T12:15:00Z");
    assert.equal(err.evidenceId, EVIDENCE);
    return true;
  });
  assert.equal(withUrl.wallet.signed.length, 0);

  const noUrl = setup(() => decision("step_up", ["STEP_UP_REQUIRED"]));
  await assert.rejects(noUrl.fetchPaid(URL_PAID), (err: unknown) => {
    assert.ok(err instanceof ProkuraStepUpError);
    assert.equal(err.approvalUrl, undefined);
    assert.match(err.message, /prokuraPay/);
    return true;
  });
});

test("no grant in the session: ProkuraGrantError with the grant URL, no payment", async () => {
  const t = setup(() =>
    refused({ error: "grant_pending", message: "The grant is waiting for a human.", grantUrl: "https://approve.prokura.network/g/t" }),
  );
  await assert.rejects(t.fetchPaid(URL_PAID), (err: unknown) => {
    assert.ok(err instanceof ProkuraGrantError);
    assert.equal(err.code, "grant_pending");
    assert.equal(err.grantUrl, "https://approve.prokura.network/g/t");
    return true;
  });
  assert.equal(t.wallet.signed.length, 0);
});

test("sub-cent price: refused before Prokura or the wallet is asked", async () => {
  const t = setup(() => decision("allow"), "1000");
  await assert.rejects(t.fetchPaid(URL_PAID), ProkuraMappingError);
  assert.equal(t.calls.length, 0);
  assert.equal(t.wallet.signed.length, 0);
});

test("no 402: no check, no receipt", async () => {
  const t = setup(() => decision("allow"));
  const res = await t.fetchPaid("https://api.weather.example.com/free");
  assert.equal(res.status, 200);
  assert.equal(t.calls.length, 0);
  assert.equal(t.guard.receiptOf(res), undefined);
});

test("parallel requests keep their own decisions", async () => {
  const t = setup((call) => {
    const url = (call.args.reference as { resource: string }).resource;
    return url.endsWith("/denied") ? decision("deny", ["CAP_PER_TX_EXCEEDED"]) : decision("allow");
  });
  const [a, b] = await Promise.allSettled([
    t.fetchPaid("https://api.weather.example.com/ok"),
    t.fetchPaid("https://api.weather.example.com/denied"),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.ok((b as PromiseRejectedResult).reason instanceof ProkuraDeniedError);
  assert.equal(t.wallet.signed.length, 1);
});

test("v1 challenge in the response body works the same way", async () => {
  const { mcp, calls } = mockMcp(() => decision("allow"));
  const guard = createProkuraGuard({ mcp });
  const wallet = fakeWallet();
  const client = guard.protect(new x402Client().registerV1("base-sepolia", wallet.scheme));
  const server = mock402Server(
    (url) => ({
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          maxAmountRequired: "1000000",
          resource: url,
          description: "Report",
          mimeType: "application/json",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          extra: {},
        },
      ],
    }),
    { header: false },
  );
  const fetchPaid = guard.wrapFetch(wrapFetchWithPayment(server.fetch, client));
  const res = await fetchPaid("https://data.example.org/report");
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.args.amount, "1.00");
  assert.deepEqual(calls[0]!.args.payee, { type: "domain", value: "data.example.org" });
  assert.equal(guard.receiptOf(res)?.evidenceId, EVIDENCE);
});

test("the hook alone (without wrapFetch) still blocks the payment", async () => {
  const { mcp } = mockMcp(() => decision("deny", ["PURPOSE_NOT_ALLOWED"]));
  const guard = createProkuraGuard({ mcp });
  const wallet = fakeWallet();
  const client = guard.protect(new x402Client().register("eip155:84532", wallet.scheme));
  const server = mock402Server((url) => challengeV2(url, "10000"));
  await assert.rejects(wrapFetchWithPayment(server.fetch, client)(URL_PAID), /PURPOSE_NOT_ALLOWED/);
  assert.equal(wallet.signed.length, 0);
});

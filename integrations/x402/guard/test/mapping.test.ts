import assert from "node:assert/strict";
import { test } from "node:test";
import { atomicToDecimal, ProkuraMappingError, requirementToIntent } from "../src/index.ts";
import { challengeV2, USDC_BASE_SEPOLIA } from "./helpers.ts";

test("atomicToDecimal: whole cents only", () => {
  assert.equal(atomicToDecimal("10000", 6), "0.01");
  assert.equal(atomicToDecimal("1230000", 6), "1.23");
  assert.equal(atomicToDecimal("100000000", 6), "100.00");
  assert.equal(atomicToDecimal("5", 0), "5.00");
  assert.equal(atomicToDecimal("123456789010000000000000000", 18), "123456789.01");
  assert.throws(() => atomicToDecimal("1000", 6), ProkuraMappingError); // 0.001 USDC
  assert.throws(() => atomicToDecimal("10001", 6), ProkuraMappingError); // 0.010001 USDC
  assert.throws(() => atomicToDecimal("0", 6), ProkuraMappingError);
  assert.throws(() => atomicToDecimal("-1", 6), ProkuraMappingError);
  assert.throws(() => atomicToDecimal("1.5", 6), ProkuraMappingError);
});

test("v2 challenge: payee is the resource host, reference.resource is the URL", () => {
  const pr = challengeV2("https://api.weather.example.com/forecast?city=berlin", "50000");
  const intent = requirementToIntent(pr, pr.accepts[0]!, { agentName: "travel-bot", item: "forecast" });
  assert.deepEqual(intent, {
    amount: "0.05",
    currency: "USDC",
    payee: { type: "domain", value: "api.weather.example.com" },
    purpose: "api_usage",
    rail: "x402",
    reference: {
      resource: "https://api.weather.example.com/forecast?city=berlin",
      description: "Weather forecast",
      item: "forecast",
    },
    agent_name: "travel-bot",
  });
});

test("v1 challenge: maxAmountRequired and requirement.resource", () => {
  const pr = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "2000000",
        resource: "https://Data.Example.org./v1/report",
        description: "",
        mimeType: "application/json",
        payTo: "0x2222222222222222222222222222222222222222",
        maxTimeoutSeconds: 60,
        asset: USDC_BASE_SEPOLIA.toLowerCase(),
        extra: {},
      },
    ],
  };
  const intent = requirementToIntent(pr, pr.accepts[0]!, { purpose: "research", mandateId: "urn:uuid:m1" });
  assert.equal(intent.amount, "2.00");
  assert.equal(intent.payee.value, "data.example.org");
  assert.equal(intent.purpose, "research");
  assert.equal(intent.mandateId, "urn:uuid:m1");
  assert.equal(intent.reference.description, undefined);
});

test("payeeDomain: a parent domain is allowed, a foreign one is refused", () => {
  const pr = challengeV2("https://api.weather.example.com/f", "10000");
  const req = pr.accepts[0]!;
  assert.equal(requirementToIntent(pr, req, { payeeDomain: "example.com" }).payee.value, "example.com");
  assert.equal(
    requirementToIntent(pr, req, { payeeDomain: (h) => h.split(".").slice(-2).join(".") }).payee.value,
    "example.com",
  );
  assert.throws(() => requirementToIntent(pr, req, { payeeDomain: "ample.com" }), /not on the payee domain/);
  assert.throws(() => requirementToIntent(pr, req, { payeeDomain: "evil.com" }), ProkuraMappingError);
});

test("refuses what Prokura cannot express", () => {
  const sub = challengeV2("https://a.example.com/x", "1500");
  assert.throws(() => requirementToIntent(sub, sub.accepts[0]!), /below one cent/);
  const ip = challengeV2("http://127.0.0.1:8080/x", "10000");
  assert.throws(() => requirementToIntent(ip, ip.accepts[0]!), /not a domain name/);
  const local = challengeV2("http://localhost/x", "10000");
  assert.throws(() => requirementToIntent(local, local.accepts[0]!), /not a domain name/);
  const ftp = challengeV2("ftp://a.example.com/x", "10000");
  assert.throws(() => requirementToIntent(ftp, ftp.accepts[0]!), /not http/);
  const odd = challengeV2("https://a.example.com/x", "10000", "0xdeadbeef");
  assert.throws(() => requirementToIntent(odd, odd.accepts[0]!), /unknown/);
  assert.equal(
    requirementToIntent(odd, odd.accepts[0]!, { assets: { "0xDEADBEEF": { currency: "EURC", decimals: 6 } } })
      .currency,
    "EURC",
  );
  const none = { x402Version: 1, accepts: [{ ...sub.accepts[0]!, amount: "10000" }] };
  assert.throws(() => requirementToIntent(none, none.accepts[0]!), /no resource URL/);
  assert.equal(
    requirementToIntent(none, none.accepts[0]!, {}, "https://fallback.example.com/r").payee.value,
    "fallback.example.com",
  );
});

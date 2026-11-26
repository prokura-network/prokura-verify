// Regenerates fixtures/jcs-vectors.json and fixtures/synthetic-chain.json.
// The synthetic chain is NOT from Prokura: it is signed with a throwaway test key
// so the v1 path and the genesis link can be tested. Real data lives in nachweis-demo-*.json.
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { canonicalize, recordHash, intentHash, GENESIS } from "../src/index.js";

const inputs: unknown[] = [
  { b: 1, a: [true, false, null], "€": "x", "\u0080": "y", "\ud83d\ude00": "z", "10": 0, "1": 1 },
  [0, -0, 1e21, 1e-7, 123456789012345680000, 0.000001, 1.5e300, 5e-324, 4.35, 100, -1.25e-10, 9007199254740991],
  { s: "quote\" backslash\\ ctrl\u0001\u001f tab\t nl\n del\u007f ls\u2028 é 😀" },
  { nested: { z: { y: [{ b: 2, a: 1 }] }, a: "" } },
];
writeFileSync("../../fixtures/jcs-vectors.json", JSON.stringify(inputs.map((input) => ({ input, canonical: canonicalize(input) })), null, 2) + "\n");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b: Uint8Array) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const did = "did:key:z" + b58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));

const intent = { amount: "9.00", currency: "EUR", payee: { type: "domain", value: "example.org" }, purpose: "software", rail: "mollie" };
const base = { mandateId: "M1", agentId: "did:key:example-agent", principalId: "did:web:example.org", rail: "mollie", amount: "9.00", currency: "EUR", payee: intent.payee };
const records: any[] = [];
let prev = GENESIS;
// record 1: v1 (no v field), record 2 and 3: v2 on the same mandate
const shapes = [
  { id: "R1", kind: "pay", decision: "allow", reasons: ["OK"], railRef: "tr_1", railStatus: "paid" },
  { id: "R2", kind: "pay", decision: "deny", reasons: ["CAP_PERIOD_EXCEEDED"], railRef: null, railStatus: null, v: 2, mandateSeq: 1, agentName: "synthetic" },
  { id: "R3", kind: "pay", decision: "step_up", reasons: ["FOUR_EYES_REQUIRED"], railRef: null, railStatus: null, v: 2, mandateSeq: 2, agentName: null },
];
let mprev = GENESIS;
shapes.forEach((s, i) => {
  const r: any = { ...base, ...s, refId: null, stepUp: null, gateState: { now: `2026-01-01T00:00:0${i}.000Z` }, intent, intentHash: intentHash(intent), prevHash: prev, createdAt: `2026-01-01T00:00:0${i}.500Z` };
  if (r.v === 2) r.mandatePrevHash = mprev;
  r.hash = recordHash(r);
  r.signature = sign(null, Buffer.from(r.hash, "hex"), privateKey).toString("base64url");
  if (r.v === 2) mprev = r.hash;
  prev = r.hash;
  records.push(r);
});
writeFileSync("../../fixtures/synthetic-chain.json", JSON.stringify({ format: "nachweis/v1", note: "SYNTHETIC test data signed with a throwaway key. Not issued by Prokura.", server: did, records }, null, 2) + "\n");
console.log("wrote vectors and synthetic chain", did);

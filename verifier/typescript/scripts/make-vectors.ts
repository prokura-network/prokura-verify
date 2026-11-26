// Regenerates the synthetic fixtures:
//   fixtures/jcs-vectors.json        RFC 8785 vectors
//   fixtures/synthetic-chain.json    v1 + v2 records from genesis
//   fixtures/merkle-vectors.json     roots and audit paths for trees of 0..9 leaves
//   fixtures/synthetic-proofs.json   a signed merkle-proof/v1 and merkle-checkpoint-proof/v1
//   fixtures/synthetic-rotation.json a Nachweis whose records span a server key rotation
// None of this is production data: it is signed with throwaway keys made here.
// Real data lives in nachweis-demo-*.json and root-*.json.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { canonicalize, recordHash, intentHash, GENESIS, inclusionProof, merkleRoot, recordLeaf } from "../src/index.js";

/** Prokura signatures are base64url WITH "=" padding (86 characters + "==" for Ed25519). */
const b64urlPadded = (b: Uint8Array) => {
  const s = Buffer.from(b).toString("base64url");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const inputs: unknown[] = [
  { b: 1, a: [true, false, null], "€": "x", "\u0080": "y", "\ud83d\ude00": "z", "10": 0, "1": 1 },
  [0, -0, 1e21, 1e-7, 123456789012345680000, 0.000001, 1.5e300, 5e-324, 4.35, 100, -1.25e-10, 9007199254740991],
  { s: "quote\" backslash\\ ctrl\u0001\u001f tab\t nl\n del\u007f ls\u2028 é 😀" },
  { nested: { z: { y: [{ b: 2, a: 1 }] }, a: "" } },
];
writeFileSync("../../fixtures/jcs-vectors.json", JSON.stringify(inputs.map((input) => ({ input, canonical: canonicalize(input) })), null, 2) + "\n");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b: Uint8Array) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
function newKey(): { privateKey: KeyObject; did: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { privateKey, did: "did:key:z" + b58(Buffer.concat([Buffer.from([0xed, 0x01]), raw])) };
}
const signJcs = (value: unknown, key: KeyObject) => b64urlPadded(sign(null, Buffer.from(canonicalize(value)), key));
const signHash = (hashHex: string, key: KeyObject) => b64urlPadded(sign(null, Buffer.from(hashHex, "hex"), key));

const { privateKey, did } = newKey();

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
  r.signature = signHash(r.hash, privateKey);
  if (r.v === 2) mprev = r.hash;
  prev = r.hash;
  records.push(r);
});
writeFileSync("../../fixtures/synthetic-chain.json", JSON.stringify({ format: "nachweis/v1", note: "SYNTHETIC test data signed with a throwaway key. Not issued by Prokura.", server: did, records }, null, 2) + "\n");

// Merkle vectors: leaves are the raw bytes of 32-byte record hashes, as in a day of evidence.
const leafHashes = (n: number) =>
  Array.from({ length: n }, (_, i) => createHash("sha256").update(`record ${i}`).digest("hex"));
const merkle = Array.from({ length: 10 }, (_, n) => {
  const hashes = leafHashes(n);
  const leaves = hashes.map(recordLeaf);
  return {
    treeSize: n,
    recordHashes: hashes,
    root: hex(merkleRoot(leaves)),
    auditPaths: leaves.map((_, m) => inclusionProof(m, leaves).map(hex)),
  };
});
writeFileSync("../../fixtures/merkle-vectors.json", JSON.stringify({ note: "Roots and audit paths per docs/nachweis-format.md §5 (RFC 9162). Leaf = SHA-256(0x00 || 32-byte record hash).", vectors: merkle }, null, 2) + "\n");

// Signed proofs over the synthetic chain's three records (one UTC day).
const day = records.map((r) => recordLeaf(r.hash));
const rootBody = {
  format: "merkle-root/v1", date: "2026-01-01", treeSize: day.length, root: hex(merkleRoot(day)),
  firstRecordId: records[0].id, lastRecordId: records.at(-1).id, publishedAt: "2026-01-02T00:05:00.000Z", server: did,
};
const cpBody = {
  format: "merkle-checkpoint/v1", id: "2026-01-01T00", date: "2026-01-01", from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z",
  treeSize: day.length, root: hex(merkleRoot(day)), firstRecordId: records[0].id, lastRecordId: records.at(-1).id,
  publishedAt: "2026-01-01T01:00:31.000Z", server: did,
};
const proofs = {
  note: "SYNTHETIC test data signed with a throwaway key. Not issued by Prokura.",
  rootProof: {
    format: "merkle-proof/v1", recordId: records[1].id, recordHash: records[1].hash, leafIndex: 1,
    auditPath: inclusionProof(1, day).map(hex), root: { ...rootBody, signature: signJcs(rootBody, privateKey) },
  },
  checkpointProof: {
    format: "merkle-checkpoint-proof/v1", recordId: records[2].id, recordHash: records[2].hash, leafIndex: 2,
    auditPath: inclusionProof(2, day).map(hex), checkpoint: { ...cpBody, signature: signJcs(cpBody, privateKey) },
  },
};
writeFileSync("../../fixtures/synthetic-proofs.json", JSON.stringify(proofs, null, 2) + "\n");

// Key rotation: R1 signed by an old key, R2 by the current key; the export lists both windows.
const oldKey = newKey();
const curKey = newKey();
const rot: any[] = [];
let rprev = GENESIS;
[["K1", "2026-02-01T09:00:00.000Z", oldKey], ["K2", "2026-02-01T11:00:00.000Z", curKey]].forEach(([id, at, k]: any) => {
  const r: any = { ...base, id, kind: "check", decision: "allow", reasons: ["OK"], railRef: null, railStatus: null, refId: null, stepUp: null, gateState: { now: at }, intent, intentHash: intentHash(intent), prevHash: rprev, createdAt: at };
  r.hash = recordHash(r);
  r.signature = signHash(r.hash, k.privateKey);
  rprev = r.hash;
  rot.push(r);
});
const rotBody = {
  format: "nachweis/v1", exportedAt: "2026-02-01T12:00:00.000Z", subject: "K1", records: rot, server: curKey.did,
  serverKeys: [
    { id: oldKey.did, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-02-01T10:00:00.000Z" },
    { id: curKey.did, validFrom: "2026-02-01T10:00:00.000Z", validUntil: null },
  ],
};
writeFileSync(
  "../../fixtures/synthetic-rotation.json",
  // No "note" field here: the export proof covers every top-level field.
  JSON.stringify({ ...rotBody, proof: { type: "Ed25519Canonical", verificationMethod: curKey.did, signature: signJcs(rotBody, curKey.privateKey) } }, null, 2) + "\n",
);
console.log("wrote vectors, synthetic chain, Merkle vectors, proofs and rotation", did);

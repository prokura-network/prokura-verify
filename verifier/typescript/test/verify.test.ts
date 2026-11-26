import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalize, recordHash, verifyNachweis, verifyRoot, verifyProof, verifyAny, merkleLeaf, merkleNode,
  merkleRoot, inclusionProof, verifyInclusion, recordLeaf,
} from "../src/index.js";

const fx = (f: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${f}`, import.meta.url), "utf8"));
// Our evidence server key, as published at GET https://api.prokura.network/v1/public/keys and in every signed daily root.
const SERVER = "did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L";
const REAL = ["nachweis-demo-allow.json", "nachweis-demo-step-up.json", "nachweis-demo-deny.json"];

for (const f of REAL) {
  test(`real demo Nachweis verifies: ${f}`, () => {
    const r = verifyNachweis(fx(f), { serverKey: SERVER });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.exportProof, "OK");
    for (const rec of r.records) {
      assert.equal(rec.hash, "OK");
      assert.equal(rec.signature, "OK");
      assert.match(String(rec.mandateLink), /^OK/);
    }
  });
}

test("signed daily root verifies with the pinned key", () => {
  assert.equal(verifyRoot(fx("root-2026-11-25.json"), { serverKey: SERVER }).ok, true);
});

test("tampered amount breaks the hash", () => {
  const d = fx("nachweis-demo-allow.json");
  d.records[1].amount = "1200.00";
  const r = verifyNachweis(d, { serverKey: SERVER });
  assert.equal(r.ok, false);
  assert.equal(r.records[1].hash, "FAIL");
});

test("tampered decision breaks the hash", () => {
  const d = fx("nachweis-demo-deny.json");
  d.records[6].decision = "allow";
  d.records[6].reasons = ["OK"];
  assert.equal(verifyNachweis(d, { serverKey: SERVER }).records[6].hash, "FAIL");
});

test("re-hashed but unsigned record fails the signature", () => {
  const d = fx("nachweis-demo-allow.json");
  d.records[1].amount = "99.00";
  d.records[1].hash = recordHash(d.records[1]);
  const r = verifyNachweis(d, { serverKey: SERVER });
  assert.equal(r.records[1].hash, "OK");
  assert.equal(r.records[1].signature, "FAIL");
  assert.equal(r.ok, false);
});

test("removed record breaks the chain", () => {
  const d = fx("nachweis-demo-allow.json");
  d.records.splice(2, 1);
  const r = verifyNachweis(d, { serverKey: SERVER });
  assert.equal(r.records[2].link, "FAIL");
  assert.equal(r.ok, false);
});

test("wrong pinned key fails signatures", () => {
  const r = verifyNachweis(fx("nachweis-demo-allow.json"), { serverKey: fx("synthetic-chain.json").server });
  assert.equal(r.ok, false);
  assert.match(String(r.serverKey), /^FAIL/);
  assert.match(String(r.records[0].signature), /^FAIL/);
});

test("tampered export body fails the export proof", () => {
  const d = fx("nachweis-demo-allow.json");
  d.subject = "01M8C9B9F958TJ6SCM74T1FGED";
  assert.equal(verifyNachweis(d, { serverKey: SERVER }).exportProof, "FAIL");
});

test("tampered root fails", () => {
  const d = fx("root-2026-11-25.json");
  d.treeSize = 1;
  assert.equal(verifyRoot(d, { serverKey: SERVER }).ok, false);
});

test("synthetic chain (v1 + v2 from genesis) verifies", () => {
  const d = fx("synthetic-chain.json");
  const r = verifyNachweis(d, { serverKey: d.server });
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  assert.equal(r.records[0].link, "OK (genesis)");
  assert.equal(r.records[1].mandateLink, "OK (genesis)");
});

test("RFC 8785 vectors", () => {
  for (const v of fx("jcs-vectors.json")) assert.equal(canonicalize(v.input), v.canonical);
});

test("Merkle prefixes", () => {
  const a = merkleLeaf(Buffer.from("a"));
  assert.equal(a.length, 32);
  assert.notDeepEqual(merkleNode(a, a), merkleLeaf(Buffer.concat([a, a])));
});

test("signatures are base64url with padding (86 characters + \"==\")", () => {
  const sigs = [
    ...REAL.flatMap((f) => { const d = fx(f); return [...d.records.map((r: any) => r.signature), d.proof.signature]; }),
    fx("root-2026-11-25.json").signature,
  ];
  for (const s of sigs) assert.match(s, /^[A-Za-z0-9_-]{86}==$/);
});

test("Merkle vectors: roots and audit paths (RFC 9162)", () => {
  const { vectors } = fx("merkle-vectors.json");
  assert.equal(vectors[0].root, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"); // SHA-256("")
  for (const v of vectors) {
    const leaves = v.recordHashes.map(recordLeaf);
    assert.equal(Buffer.from(merkleRoot(leaves)).toString("hex"), v.root, `size ${v.treeSize}`);
    leaves.forEach((leaf: Uint8Array, m: number) => {
      assert.deepEqual(inclusionProof(m, leaves).map((h) => Buffer.from(h).toString("hex")), v.auditPaths[m]);
      const path = v.auditPaths[m].map((h: string) => Buffer.from(h, "hex"));
      assert.equal(verifyInclusion(leaf, m, v.treeSize, path, Buffer.from(v.root, "hex")), true);
      if (v.treeSize > 1) {
        assert.equal(verifyInclusion(leaf, (m + 1) % v.treeSize, v.treeSize, path, Buffer.from(v.root, "hex")), false, "wrong index");
      }
    });
  }
});

test("Merkle: an odd leaf is promoted, never duplicated", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => merkleLeaf(Buffer.from(x)));
  assert.deepEqual(merkleRoot([a, b, c]), merkleNode(merkleNode(a, b), c));
  assert.notDeepEqual(merkleRoot([a, b, c]), merkleRoot([a, b, c, c]));
});

test("signed inclusion proofs verify (daily root and hourly checkpoint)", () => {
  const p = fx("synthetic-proofs.json");
  const key = fx("synthetic-chain.json").server;
  const chain = fx("synthetic-chain.json");
  const r = verifyProof(p.rootProof, { serverKey: key, recordHash: chain.records[1].hash });
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  assert.equal(r.record, "OK");
  const c = verifyAny(p.checkpointProof, { serverKey: key, recordHash: chain.records[2].hash });
  assert.equal(c.kind, "proof");
  assert.equal(c.ok, true, JSON.stringify(c, null, 2));
  assert.equal(verifyAny(p.checkpointProof.checkpoint, { serverKey: key }).ok, true);
});

test("tampered inclusion proofs fail", () => {
  const key = fx("synthetic-chain.json").server;
  const chain = fx("synthetic-chain.json");
  const cases: Array<[string, (p: any) => void]> = [
    ["leaf index", (p) => { p.leafIndex = 0; }],
    ["record hash", (p) => { p.recordHash = chain.records[0].hash; }],
    ["audit path", (p) => { p.auditPath[0] = "0".repeat(64); }],
    ["root value", (p) => { p.root.root = "0".repeat(64); }],
    ["tree size", (p) => { p.root.treeSize = 4; }],
  ];
  for (const [name, edit] of cases) {
    const p = fx("synthetic-proofs.json").rootProof;
    edit(p);
    assert.equal(verifyProof(p, { serverKey: key }).ok, false, name);
  }
  const p = fx("synthetic-proofs.json").rootProof;
  assert.equal(verifyProof(p, { serverKey: key, recordHash: chain.records[0].hash }).ok, false, "bound to another record");
  assert.equal(verifyProof(p, { serverKey: SERVER }).ok, false, "unpinned key");
});

test("key rotation: each record is checked against the key valid at its createdAt", () => {
  const d = fx("synthetic-rotation.json");
  const ring = d.serverKeys.map((k: any) => k.id);
  const r = verifyNachweis(d, { serverKey: ring });
  assert.equal(r.ok, true, JSON.stringify(r, null, 2));
  assert.equal(r.serverKeys, "OK");
  // Pinning only the current key rejects the record signed by the retired key.
  const cur = verifyNachweis(d, { serverKey: d.server });
  assert.equal(cur.ok, false);
  assert.match(String(cur.records[0].signature), /^FAIL/);
  assert.equal(cur.records[1].signature, "OK");
  // Moving the rotation time makes the first record check against the wrong key.
  const t = fx("synthetic-rotation.json");
  t.serverKeys[0].validUntil = t.serverKeys[1].validFrom = "2026-02-01T08:00:00.000Z";
  assert.equal(verifyNachweis(t, { serverKey: ring }).ok, false);
});

/**
 * Offline verifier for Prokura Nachweis exports, signed daily roots, hourly
 * checkpoints and Merkle inclusion proofs.
 *
 * Every rule is specified in docs/nachweis-format.md. Section numbers in the
 * comments below (§n) refer to that document.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import canonicalizeLib from "canonicalize";

// canonicalize ships CJS + ESM typings that differ between versions; normalise.
const jcs = canonicalizeLib as unknown as (v: unknown) => string | undefined;

export const GENESIS = "0".repeat(64);

/** §3.2: the remaining stored fields, in the object that closes the hashed array. */
export const RECORD_FIELDS = [
  "id", "kind", "refId", "mandateId", "agentId", "principalId", "intentHash",
  "stepUp", "gateState", "rail", "railStatus", "amount", "currency", "payee",
] as const;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type NachweisRecord = { [k: string]: Json | undefined };

export function canonicalize(value: unknown): string {
  const s = jcs(value);
  if (s === undefined) throw new Error("value cannot be canonicalized");
  return s;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** §3.2: SHA-256 over RFC 8785 [prevHash, intent, decision, reasons, railRef, createdAt, rest]. */
export function recordHash(r: NachweisRecord): string {
  const rest: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) rest[k] = r[k]; // a missing key is left out (JCS drops undefined)
  if (r.v === 2) {
    rest.v = 2;
    rest.mandateSeq = r.mandateSeq ?? null;
    rest.mandatePrevHash = r.mandatePrevHash ?? null;
    rest.agentName = r.agentName ?? null;
  }
  return sha256Hex(canonicalize([r.prevHash, r.intent, r.decision, r.reasons, r.railRef, r.createdAt, rest]));
}

/** §3.4: "sha256:" + hex SHA-256 of the canonical intent, agentSignature included. */
export const intentHash = (intent: unknown) => "sha256:" + sha256Hex(canonicalize(intent));

/** §5: RFC 9162 leaf hash, SHA-256(0x00 || data). */
export const merkleLeaf = (leaf: Uint8Array) => createHash("sha256").update(Buffer.from([0])).update(leaf).digest();
/** §5: RFC 9162 node hash, SHA-256(0x01 || left || right). */
export const merkleNode = (l: Uint8Array, r: Uint8Array) =>
  createHash("sha256").update(Buffer.from([1])).update(l).update(r).digest();
/** §5: the leaf of an evidence record is its 32-byte hash (the raw bytes of the hex `hash`). */
export const recordLeaf = (recordHashHex: string) => merkleLeaf(Buffer.from(recordHashHex, "hex"));

const split = (n: number) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

/** §5: Merkle Tree Hash over leaf hashes (RFC 9162 §2.1.1). The empty tree hashes to SHA-256(""). */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return createHash("sha256").digest();
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return merkleNode(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** §5: audit path for leaf m (RFC 9162 §2.1.3.1). */
export function inclusionProof(m: number, leaves: Uint8Array[]): Uint8Array[] {
  if (m < 0 || m >= leaves.length) throw new RangeError("leaf index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return m < k
    ? [...inclusionProof(m, leaves.slice(0, k)), merkleRoot(leaves.slice(k))]
    : [...inclusionProof(m - k, leaves.slice(k)), merkleRoot(leaves.slice(0, k))];
}

/** §5: verify an audit path (RFC 9162 §2.1.3.2). */
export function verifyInclusion(leaf: Uint8Array, index: number, treeSize: number, path: Uint8Array[], root: Uint8Array): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize) || index < 0 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r: Uint8Array = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = merkleNode(p, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = merkleNode(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && Buffer.from(r).equals(Buffer.from(root));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  while (s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/** did:key:z6Mk... -> 32-byte Ed25519 public key (multicodec 0xed01). */
export function didKeyToEd25519(did: string): Uint8Array {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)(?:#.*)?$/.exec(did);
  if (!m) throw new Error("not a base58btc did:key");
  const raw = b58decode(m[1]);
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an Ed25519 did:key");
  return raw.slice(2);
}

function ed25519Ok(pub: Uint8Array, sigB64url: unknown, msg: Uint8Array): boolean {
  if (typeof sigB64url !== "string" || !sigB64url) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
    return edVerify(null, msg, key, Buffer.from(sigB64url.trim(), "base64url"));
  } catch {
    return false;
  }
}

/** A pinned key, a list of pinned keys (the published key ring), or nothing. */
export type PinnedKeys = string | string[] | undefined;

const bareDid = (k: string) => k.split("#")[0];
const pinnedSet = (p: PinnedKeys) =>
  p === undefined || (Array.isArray(p) && p.length === 0) ? undefined : new Set([p].flat().map(bareDid));
const SELF_ASSERTED =
  "server key taken from the file itself (self-asserted). Pin it with --server-key: the 'evidence' key from GET https://api.prokura.network/v1/public/keys, or the 'server' of a signed daily root";

/** §4: the key that signed a record: the serverKeys window that contains its createdAt, else `server`. */
export function serverKeyAt(keys: unknown, createdAt: unknown, fallback: string): string {
  if (!Array.isArray(keys) || typeof createdAt !== "string") return fallback;
  const t = Date.parse(createdAt);
  const k = keys.find(
    (w: any) => w && typeof w.id === "string" && Date.parse(w.validFrom) <= t && (w.validUntil == null || t < Date.parse(w.validUntil)),
  );
  return k?.id ?? fallback;
}

/** Ed25519 public key for a did:key, or null if it is not one. */
function keyBytes(did: string): Uint8Array | null {
  try { return didKeyToEd25519(did); } catch { return null; }
}

export interface RecordResult { id: unknown; kind: unknown; decision: unknown; [check: string]: unknown }
export interface Report {
  ok: boolean;
  records: RecordResult[];
  exportProof?: string;
  /** Set only on failure: the export's server key is not among the pinned keys. */
  serverKey?: string;
  /** Set when the export carries serverKeys (a key rotation). */
  serverKeys?: string;
  warnings: string[];
}

const isFail = (v: unknown) => typeof v === "string" && v.startsWith("FAIL");

export function verifyNachweis(input: unknown, opts: { serverKey?: PinnedKeys } = {}): Report {
  const warnings: string[] = [];
  const doc = (Array.isArray(input) ? {} : (input ?? {})) as Record<string, any>;
  const records = (Array.isArray(input) ? input : doc.records) as NachweisRecord[] | undefined;
  if (!Array.isArray(records) || records.length === 0) throw new Error("no records found");
  if (doc.format !== undefined && doc.format !== "nachweis/v1") warnings.push(`unknown format ${JSON.stringify(doc.format)}`);

  const pinned = pinnedSet(opts.serverKey);
  // A bare list of records has no `server`; a single pinned key stands in for it.
  const server: string | undefined =
    typeof doc.server === "string" ? bareDid(doc.server) : pinned?.size === 1 ? [...pinned][0] : undefined;
  if (!server) warnings.push("no server key: record signatures not checked");
  else if (!pinned) warnings.push(SELF_ASSERTED);
  const subjectId: string | undefined = doc.credential?.credentialSubject?.id;

  const results: RecordResult[] = [];
  let failures = 0;
  let prev: string | undefined;
  const lastByMandate = new Map<unknown, NachweisRecord>();

  const report: Report = { ok: false, records: results, warnings };
  if (pinned && server && !pinned.has(server)) {
    report.serverKey = `FAIL (${server} is not a pinned key)`;
    failures++;
  }
  if (doc.serverKeys !== undefined) {
    const listed = Array.isArray(doc.serverKeys) && doc.serverKeys.some((k: any) => k?.id === doc.server);
    report.serverKeys = listed ? "OK" : "FAIL (serverKeys does not list the export's server key)";
    if (!listed) failures++;
  }

  records.forEach((r, i) => {
    const res: RecordResult = { id: r.id, kind: r.kind, decision: r.decision };
    try { res.hash = recordHash(r) === r.hash ? "OK" : "FAIL"; } catch (e) { res.hash = `FAIL (${(e as Error).message})`; }

    if (i === 0) res.link = r.prevHash === GENESIS ? "OK (genesis)" : "EXTERNAL (chain starts before this file)";
    else res.link = r.prevHash === prev ? "OK" : "FAIL";
    prev = r.hash as string;

    if (r.v === 2) {
      const last = lastByMandate.get(r.mandateId);
      if (last) {
        res.mandateLink = r.mandatePrevHash === last.hash && r.mandateSeq === ((last.mandateSeq as number) ?? 0) + 1 ? "OK" : "FAIL";
      } else if (r.mandateSeq === 1) {
        res.mandateLink = r.mandatePrevHash === GENESIS ? "OK (genesis)" : "FAIL";
      } else {
        res.mandateLink = "EXTERNAL (earlier records of this mandate are not in this file)";
      }
      lastByMandate.set(r.mandateId, r);
    }

    if (server) {
      const key = serverKeyAt(doc.serverKeys, r.createdAt, server);
      const pub = keyBytes(key);
      const h = typeof r.hash === "string" && /^[0-9a-f]{64}$/.test(r.hash) ? Buffer.from(r.hash, "hex") : null;
      if (pinned && !pinned.has(key)) res.signature = `FAIL (signed by ${key}, which is not pinned)`;
      else res.signature = pub && h && ed25519Ok(pub, r.signature, h) ? "OK" : "FAIL";
    }

    const intent = r.intent as Record<string, any> | undefined;
    if (intent && typeof intent === "object" && "intentHash" in r) res.intentHash = intentHash(intent) === r.intentHash ? "OK" : "FAIL";
    if (intent && typeof intent === "object" && intent.agentSignature && intent.agentId) {
      const { agentSignature, ...unsigned } = intent;
      try {
        res.agentSignature = ed25519Ok(didKeyToEd25519(intent.agentId), agentSignature, Buffer.from(canonicalize(unsigned))) ? "OK" : "FAIL";
      } catch {
        res.agentSignature = "UNSUPPORTED (agentId is not an Ed25519 did:key)";
      }
      if (subjectId) res.agentIsCredentialSubject = intent.agentId === subjectId ? "OK" : "FAIL";
    }

    if (Object.entries(res).some(([k, v]) => !["id", "kind", "decision"].includes(k) && isFail(v))) failures++;
    results.push(res);
  });

  if (doc.proof && typeof doc.proof === "object" && typeof doc.server === "string") {
    const { proof, ...body } = doc;
    const pub = keyBytes(bareDid(doc.server));
    const ok = !!pub && ed25519Ok(pub, proof.signature, Buffer.from(canonicalize(body)));
    const byServer = typeof proof.verificationMethod !== "string" || bareDid(proof.verificationMethod) === bareDid(doc.server);
    report.exportProof = ok && byServer ? "OK" : byServer ? "FAIL" : "FAIL (proof.verificationMethod is not the server key)";
    if (!ok || !byServer) failures++;
  }
  report.ok = failures === 0;
  return report;
}

const SIGNED_TREE_HEADS = ["merkle-root/v1", "merkle-checkpoint/v1"];

/** §6: a signed daily root or hourly checkpoint: Ed25519 by `server` over JCS(document without "signature"). */
export function verifyRoot(doc: Record<string, any>, opts: { serverKey?: PinnedKeys } = {}) {
  const warnings: string[] = [];
  if (!doc || typeof doc !== "object") throw new Error("not a JSON object");
  if (doc.format !== undefined && !SIGNED_TREE_HEADS.includes(doc.format)) warnings.push(`unknown format ${JSON.stringify(doc.format)}`);
  const pinned = pinnedSet(opts.serverKey);
  const server = typeof doc.server === "string" ? bareDid(doc.server) : pinned?.size === 1 ? [...pinned][0] : undefined;
  if (!server) throw new Error("no server key");
  if (!pinned) warnings.push(SELF_ASSERTED);
  const pub = keyBytes(server);
  const { signature, ...body } = doc;
  let sig: string;
  if (pinned && !pinned.has(server)) sig = `FAIL (${server} is not a pinned key)`;
  else sig = pub && ed25519Ok(pub, signature, Buffer.from(canonicalize(body))) ? "OK" : "FAIL";
  return {
    format: doc.format, date: doc.date, id: doc.id, root: doc.root, treeSize: doc.treeSize,
    signature: sig, warnings, ok: sig === "OK",
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * §5: an inclusion proof (merkle-proof/v1 with `root`, or merkle-checkpoint-proof/v1
 * with `checkpoint`): the signed tree head verifies, and the record's leaf is in it.
 * Pass `recordHash` (the `hash` of the record in your Nachweis) to bind the proof to it.
 */
export function verifyProof(doc: Record<string, any>, opts: { serverKey?: PinnedKeys; recordHash?: string } = {}) {
  if (!doc || typeof doc !== "object") throw new Error("not a JSON object");
  const head = doc.format === "merkle-checkpoint-proof/v1" ? doc.checkpoint : doc.root;
  const headFormat = doc.format === "merkle-checkpoint-proof/v1" ? "merkle-checkpoint/v1" : "merkle-root/v1";
  if (!head || typeof head !== "object") throw new Error(`proof has no ${headFormat} document`);
  const signed = verifyRoot(head, opts);
  const warnings = [...signed.warnings];
  const fail = (m: string) => `FAIL (${m})`;
  let inclusion: string;
  if (head.format !== headFormat) inclusion = fail(`expected a ${headFormat} document`);
  else if (typeof doc.recordHash !== "string" || !HEX64.test(doc.recordHash)) inclusion = fail("recordHash is not 64 hex");
  else if (typeof head.root !== "string" || !HEX64.test(head.root)) inclusion = fail("root is not 64 hex");
  else if (!Array.isArray(doc.auditPath) || !doc.auditPath.every((h: unknown) => typeof h === "string" && HEX64.test(h)))
    inclusion = fail("auditPath must be a list of 64-hex hashes");
  else
    inclusion = verifyInclusion(
      recordLeaf(doc.recordHash), doc.leafIndex, head.treeSize,
      doc.auditPath.map((h: string) => Buffer.from(h, "hex")), Buffer.from(head.root, "hex"),
    ) ? "OK" : "FAIL";
  let record: string | undefined;
  if (opts.recordHash !== undefined) record = opts.recordHash === doc.recordHash ? "OK" : fail("proof is for a different record hash");
  else warnings.push("proof not bound to a record: pass the record's hash (--record-hash) to check it is the one in your Nachweis");
  const ok = signed.ok && inclusion === "OK" && (record === undefined || record === "OK");
  return {
    format: doc.format, recordId: doc.recordId, recordHash: doc.recordHash, leafIndex: doc.leafIndex,
    treeSize: head.treeSize, signature: signed.signature, inclusion, ...(record ? { record } : {}), warnings, ok,
  };
}

/** Dispatch on `format`: a Nachweis export, a signed root or checkpoint, or an inclusion proof. */
export function verifyAny(doc: any, opts: { serverKey?: PinnedKeys; recordHash?: string } = {}) {
  const f = doc?.format;
  if (f === "merkle-root/v1" || f === "merkle-checkpoint/v1") return { kind: "tree-head" as const, ...verifyRoot(doc, opts) };
  if (f === "merkle-proof/v1" || f === "merkle-checkpoint-proof/v1") return { kind: "proof" as const, ...verifyProof(doc, opts) };
  return { kind: "nachweis" as const, ...verifyNachweis(doc, opts) };
}

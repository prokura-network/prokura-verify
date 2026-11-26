#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { verifyNachweis, verifyRoot } from "./index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const ki = args.indexOf("--server-key");
const serverKey = ki >= 0 ? args[ki + 1] : undefined;
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--server-key");
if (!file) {
  console.error("usage: prokura-verify FILE [--server-key did:key:z6Mk...] [--json]");
  process.exit(2);
}

let report: any;
try {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  report = doc?.format === "merkle-root/v1" ? verifyRoot(doc, { serverKey }) : verifyNachweis(doc, { serverKey });
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(2);
}

if (json) console.log(JSON.stringify(report, null, 2));
else {
  for (const w of report.warnings ?? []) console.log(`warning: ${w}`);
  if (report.records) {
    for (const r of report.records) {
      const checks = Object.entries(r).filter(([k]) => !["id", "kind", "decision"].includes(k)).map(([k, v]) => `${k}=${String(v).split(" ")[0]}`).join(" ");
      console.log(`${r.id}  ${String(r.kind).padEnd(9)} ${String(r.decision).padEnd(8)} ${checks}`);
    }
    if (report.exportProof) console.log(`export proof: ${report.exportProof}`);
  } else console.log(`root ${report.date} treeSize=${report.treeSize} signature=${report.signature}`);
  console.log(report.ok ? "VERIFIED" : "NOT VERIFIED");
}
process.exit(report.ok ? 0 : 1);

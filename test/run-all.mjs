/* 一次跑完所有自检：node test/run-all.mjs */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import process from "node:process";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs").sort();
let bad = 0;

for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) { bad++; }
}
console.log(bad ? `\n${bad} 个测试文件失败` : "\n全部测试文件通过 ✅");
process.exit(bad ? 1 : 0);

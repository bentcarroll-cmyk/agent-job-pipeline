import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { findUnresolvedImports } from "../../scripts/verify-runtime-imports";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("reports missing static, export, dynamic and type imports while accepting local and runtime built-ins", async () => {
  const root = await mkdtemp(join(tmpdir(), "imports-test-")); roots.push(root);
  await writeFile(join(root, "ok.ts"), "export const ok = true;");
  await writeFile(join(root, "entry.ts"), `import { ok } from "./ok";
import fs from "node:fs";
import { WorkflowEntrypoint } from "cloudflare:workers";
import nope from "missing-package";
export { x } from "./missing-export";
const dynamic = import("./missing-dynamic");
type Missing = import("./missing-type").Value;`);
  expect(await findUnresolvedImports(root, ["entry.ts", "ok.ts"])).toEqual([
    { path: "entry.ts", specifier: "missing-package" },
    { path: "entry.ts", specifier: "./missing-export" },
    { path: "entry.ts", specifier: "./missing-dynamic" },
    { path: "entry.ts", specifier: "./missing-type" },
  ]);
});

it("checks native JS modules and declaration imports",async()=>{const root=await mkdtemp(join(tmpdir(),"imports-native-"));roots.push(root);await writeFile(join(root,"entry.mjs"),'import "./missing.mjs";');await writeFile(join(root,"entry.d.mts"),'export { Missing } from "./missing-types.mjs";');expect(await findUnresolvedImports(root,["entry.mjs","entry.d.mts"])).toHaveLength(2);});

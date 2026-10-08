import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { scanPublicTree, scanPublicHistory } from "../../scripts/privacy-scan";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
async function repo() { const root = await mkdtemp(join(tmpdir(), "synthetic-privacy-")); roots.push(root); execFileSync("git", ["init", "-q", root]); return root; }
async function put(root: string, path: string, value: string) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), value); execFileSync("git", ["-C", root, "add", "--", path]); }
it.each([
    ["secret.txt", "xox" + "b-123456789012-123456789012-private", "credential"],
    ["contact.md", "person@" + "personalmail.com", "personal-contact"],
    ["path.md", "/Users/" + "private-person/Documents/notes", "personal-home-path"],
    ["Career_Interview_Notes.md", "raw facts", "private-artifact"],
    ["snapshots/production-ledger.json", "{}", "private-artifact"],
    ["mail/message.eml", "raw body", "private-artifact"],
])("reports only location and rule for %s", async (path, value, rule) => { const root = await repo(); await put(root, path, value); const findings = await scanPublicTree(root); expect(findings).toContainEqual({ path, line: rule === "private-artifact" ? null : 1, rule }); expect(JSON.stringify(findings)).not.toContain(value); });
it("allows only reserved synthetic contacts and exact intended license attribution", async () => { const root = await repo(); await put(root, "tests/fixture.ts", "alex@example.invalid; careers@synthetic.test"); await put(root, "LICENSE", "Copyright (c) 2026 Ben" + " Carroll. All rights reserved except as granted below."); expect(await scanPublicTree(root)).toEqual([]); await put(root, "profile.md", "Ben" + " Carroll"); expect(await scanPublicTree(root)).toContainEqual({ path: "profile.md", line: 1, rule: "personal-identity" }); });
it("finds removed content and commit metadata throughout public history", async () => { const root = await repo(); await put(root, "removed.md", "person@" + "personalmail.com"); const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Synthetic Author", "-c", "user.email=author@example.invalid", ...args]); git("commit", "-qm", "initial"); git("rm", "removed.md"); git("commit", "-qm", "Contact person@" + "personalmail.com"); expect(await scanPublicTree(root)).toEqual([]); const findings = await scanPublicHistory(root); expect(findings.some(f => f.path.endsWith(":removed.md") && f.rule === "personal-contact")).toBe(true); expect(findings.some(f => f.path.endsWith(":message") && f.rule === "personal-contact")).toBe(true); });
it.each(["Career_Evidence.md", "resume.json", "materials.json"])("rejects private input artifact %s", async (path) => { const root = await repo(); await put(root, path, "{}"); expect(await scanPublicTree(root)).toContainEqual({ path, line: null, rule: "private-artifact" }); });
it("scans annotated tag metadata", async () => { const root = await repo(); await put(root, "README.md", "safe"); const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Synthetic Author", "-c", "user.email=author@example.invalid", ...args]); git("commit", "-qm", "initial"); git("tag", "-a", "synthetic", "-m", "person@" + "personalmail.com"); expect((await scanPublicHistory(root)).some(f => f.path.includes("tag:") && f.rule === "personal-contact")).toBe(true); });
it.each([".env.local", ".dev.vars", "oauth-client.json"])("rejects secret-bearing private filename %s", async path => { const root = await repo(); await put(root,path,"private input"); expect(await scanPublicTree(root)).toContainEqual({path,line:null,rule:"private-artifact"}); });
it("rejects a personal phone and a non-prefixed credential assignment",async()=>{const root=await repo();await put(root,"config.txt",'api_key="'+"private-random-credential-123"+'"\n'+"202-"+"867-5309");const findings=await scanPublicTree(root);expect(findings.map(f=>f.rule)).toContain("credential");expect(findings.map(f=>f.rule)).toContain("personal-contact");});

it.each(["In the first production"+" run, 19 of 61 calls failed", "A real "+"example: Synthetic Co had 7321 characters", "One crash "+"left 27 matches hidden"])("flags deployment anecdotes for contextual review: %s",async prose=>{const root=await repo();await put(root,"source.ts","// "+prose);expect((await scanPublicTree(root)).some(f=>f.rule==="deployment-anecdote")).toBe(true);});

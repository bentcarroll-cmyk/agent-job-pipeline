import { Buffer } from "node:buffer";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { tar, untar, sha256 } from "../../scripts/release-format";
import { packageRelease } from "../../scripts/package-release";
import { verifyRelease } from "../../scripts/verify-release";
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "synthetic-release-")); roots.push(root); await mkdir(join(root, ".release")); const manifest = JSON.parse(await readFile(new URL("../../.release/public-manifest.json", import.meta.url), "utf8")); for (const p of manifest.files) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), "synthetic content");
} await writeFile(join(root, ".release/public-manifest.json"), JSON.stringify(manifest)); return { root, manifest, path: join(root, ".release/public-manifest.json") }; }
it("packages reproducibly and verifies exact file hashes and required closure", async () => { const { root, path } = await fixture(); const a = await packageRelease(root, path, join(root, "out1")), b = await packageRelease(root, path, join(root, "out2")); expect(a.sha256).toBe(b.sha256); expect(await verifyRelease(a.archive)).toEqual({ passed: true, failures: [] }); });
it("rejects an omitted runtime/tool/native adapter and duplicate or escaping member", async () => { for (const transform of [(f: string[]) => f.filter(p => p !== "tools/setup/core-guards.mjs"), (f: string[]) => [...f, f[0]], (f: string[]) => [...f, "../escape"], (f: string[]) => f.filter(p => p !== ".agents/skills/job-materials/SKILL.md")]) {
    const { root, path, manifest } = await fixture();
    manifest.files = transform(manifest.files);
    await writeFile(path, JSON.stringify(manifest));
    await expect(packageRelease(root, path, join(root, "out"))).rejects.toThrow();
} });
it("rejects symlinks and scanned private content before packaging", async () => { const { root, path } = await fixture(); await rm(join(root, "README.md")); await symlink("package.json", join(root, "README.md")); await expect(packageRelease(root, path, join(root, "out"))).rejects.toThrow(); await rm(join(root, "README.md")); await writeFile(join(root, "README.md"), "person@" + "personalmail.com"); await expect(packageRelease(root, path, join(root, "out"))).rejects.toThrow(); });
it("fails malformed archives and checksum tampering", async () => { const { root, path } = await fixture(); const a = await packageRelease(root, path, join(root, "out")); await writeFile(a.archive, Buffer.from("invalid")); expect((await verifyRelease(a.archive)).passed).toBe(false); });
it.each(["traversal", "symlink", "duplicate", "missing", "metadata-private"])("rejects forged archive %s even with matching outer checksum", async (kind) => {
    const { root, path } = await fixture(), a = await packageRelease(root, path, join(root, "out"));
    const entries = [...untar(gunzipSync(await readFile(a.archive)))].map(([path, bytes]) => ({ path, bytes }));
    if (kind === "duplicate")
        entries.push(entries[0]);
    if (kind === "missing")
        entries.splice(entries.findIndex(e => e.path === "tools/setup/core-guards.mjs"), 1);
    if (kind === "metadata-private") {
        const item = entries.find(e => e.path === "RELEASE-METADATA.json")!;
        const value = JSON.parse(item.bytes.toString());
        value.privateNote = "person@" + "personalmail.com";
        item.bytes = Buffer.from(JSON.stringify(value));
    }
    const raw = tar(entries);
    if (kind === "traversal" || kind === "symlink") {
        raw.fill(0, 0, 100);
        raw.set(new TextEncoder().encode(kind === "traversal" ? "../escape" : "regular"), 0);
        if (kind === "symlink")
            raw[156] = 50;
        raw.fill(32, 148, 156);
        const sum = raw.subarray(0, 512).reduce((a: number, b: number) => a + b, 0);
        raw.set(new TextEncoder().encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    }
    const zipped = gzipSync(raw);
    await writeFile(a.archive, zipped);
    await writeFile(a.archive + ".sha256", sha256(zipped) + "  agent-job-pipeline.tar.gz\n");
    expect((await verifyRelease(a.archive)).passed).toBe(false);
});
it("rejects hidden tar padding even when outer checksum matches", async () => { const { root, path } = await fixture(), a = await packageRelease(root, path, join(root, "out")); const raw = gunzipSync(await readFile(a.archive)); const size = parseInt(raw.subarray(124, 136).toString().split("\0")[0], 8); raw[512 + size] = 65; const zipped = gzipSync(raw); await writeFile(a.archive, zipped); await writeFile(a.archive + ".sha256", sha256(zipped) + "  agent-job-pipeline.tar.gz\n"); expect((await verifyRelease(a.archive)).passed).toBe(false); });
it('returns an actionable safe checksum reason without including archive contents or paths', async()=>{
 const {root,path}=await fixture();const a=await packageRelease(root,path,join(root,'out'));
 await writeFile(a.archive,Buffer.from('synthetic damaged archive'));
 expect(await verifyRelease(a.archive)).toEqual({passed:false,failures:['ARCHIVE_CHECKSUM_MISMATCH']});
});

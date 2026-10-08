import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importSource } from "../../scripts/import-source";

let root: string, source: string, target: string, sourceSha: string;
const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "source-import-test-"))); source = join(root, "source"); target = join(root, "target");
  await mkdir(join(source, "src"), { recursive: true });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(source, "src/runtime.ts"), "export const value = 1;\n");
  git("add", "src/runtime.ts"); git("commit", "-qm", "fixture"); sourceSha = git("rev-parse", "HEAD");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const manifest = (files: string[] = ["src/runtime.ts"]) => ({ sourceSha, files });

describe("importSource", () => {
  it("copies only named pinned blobs, ignoring dirty tracked content and untracked private files", async () => {
    await writeFile(join(source, "src/runtime.ts"), "dirty worktree");
    await writeFile(join(source, ".env"), "synthetic-secret");
    await mkdir(join(source, "workspace")); await writeFile(join(source, "workspace/private.json"), "synthetic-private");
    const receipt = await importSource(source, target, manifest());
    expect(await readFile(join(target, "src/runtime.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readdir(target)).toEqual(["src"]);
    expect(receipt).toEqual({ sourceSha, files: [{ path: "src/runtime.ts", sha256: "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" }] });
  });
  it("accepts an existing empty target", async () => {
    await mkdir(target); await importSource(source, target, manifest());
    expect(await readFile(join(target, "src/runtime.ts"), "utf8")).toBe("export const value = 1;\n");
  });
  it("rejects occupied targets without changing their contents", async () => {
    await mkdir(target); await writeFile(join(target, "keep"), "unchanged");
    await expect(importSource(source, target, manifest())).rejects.toThrow(/occupied/i);
    expect(await readdir(target)).toEqual(["keep"]); expect(await readFile(join(target, "keep"), "utf8")).toBe("unchanged");
  });
  it.each(["../outside", "/absolute", "src/../runtime.ts", "src\\runtime.ts", ".git/config", "", "src//runtime.ts"])("rejects unsafe manifest path %j before writes", async path => {
    await expect(importSource(source, target, manifest([path]))).rejects.toThrow(/path/i);
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a revision mismatch before writes", async () => {
    await expect(importSource(source, target, { ...manifest(), sourceSha: "a".repeat(40) })).rejects.toThrow(/revision/i);
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects untracked or missing named files before writing any valid entries", async () => {
    await writeFile(join(source, ".env"), "synthetic-secret");
    await expect(importSource(source, target, manifest(["src/runtime.ts", ".env"]))).rejects.toThrow(/tracked/i);
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a tracked symlink without following it", async () => {
    await writeFile(join(root, "outside"), "unchanged"); await symlink(join(root, "outside"), join(source, "escape"));
    git("add", "escape"); git("commit", "-qm", "symlink"); sourceSha = git("rev-parse", "HEAD");
    await expect(importSource(source, target, manifest(["escape"]))).rejects.toThrow(/symlink/i);
    expect(await readFile(join(root, "outside"), "utf8")).toBe("unchanged");
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a worktree symlink replacing a tracked directory", async () => {
    await rm(join(source, "src"), { recursive: true }); await symlink(root, join(source, "src"));
    await expect(importSource(source, target, manifest())).rejects.toThrow(/symlink/i);
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects target symlinks and symlink ancestors without writes outside target", async () => {
    await mkdir(join(root, "outside")); await symlink(join(root, "outside"), target);
    await expect(importSource(source, target, manifest())).rejects.toThrow(/symlink/i);
    await expect(importSource(source, join(target, "nested"), manifest())).rejects.toThrow(/symlink/i);
    expect(await readdir(join(root, "outside"))).toEqual([]);
  });
  it("rejects copying into the source checkout", async () => {
    await expect(importSource(source, join(source, "output"), manifest())).rejects.toThrow(/source/i);
    await expect(readdir(join(source, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([false, true])("rejects a source child starting with two dots (existing empty target=%s)", async exists => {
    const child = join(source, "..seed");
    if (exists) await mkdir(child);
    const before = await readdir(source);
    await expect(importSource(source, child, manifest())).rejects.toThrow(/source/i);
    expect(await readdir(source)).toEqual(before);
    expect(await readFile(join(source, "src/runtime.ts"), "utf8")).toBe("export const value = 1;\n");
    if (exists) expect(await readdir(child)).toEqual([]);
    else await expect(readdir(child)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects duplicate or case-colliding manifest paths before writes", async () => {
    for (const files of [["src/runtime.ts", "src/runtime.ts"], ["src/runtime.ts", "SRC/runtime.ts"]]) {
      await expect(importSource(source, target, manifest(files))).rejects.toThrow(/duplicate/i);
      await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

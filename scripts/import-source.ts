import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export interface ImportManifest { sourceSha: string; files: readonly string[] }
export interface ImportReceipt { sourceSha: string; files: readonly { path: string; sha256: string }[] }

async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function rejectSymlinks(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await rejectSymlinks(parent);
  if ((await stat(path))?.isSymbolicLink()) throw new Error(`Symlink path rejected: ${path}`);
}
function validatePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\0-\x1f\x7f]/.test(path)
      || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`Unsafe manifest path: ${path}`);
  }
}

/** Imports only regular Git blobs from the exact source HEAD; never reads file contents from its worktree. */
export async function importSource(sourceRoot: string, targetRoot: string, manifest: ImportManifest): Promise<ImportReceipt> {
  const source = resolve(sourceRoot), target = resolve(targetRoot);
  const withinSource = relative(source, target);
  if (!withinSource || (withinSource !== ".." && !withinSource.startsWith(`..${sep}`) && !isAbsolute(withinSource))) {
    throw new Error("Target must be outside the source checkout");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceSha)) throw new Error("Invalid source revision");
  const seen = new Set<string>();
  for (const path of manifest.files) {
    validatePath(path);
    if (seen.has(path.toLowerCase())) throw new Error(`Duplicate manifest path: ${path}`);
    seen.add(path.toLowerCase());
  }
  await rejectSymlinks(source); await rejectSymlinks(target);
  const targetStat = await stat(target);
  if (targetStat && (!targetStat.isDirectory() || (await readdir(target)).length)) throw new Error("Target is occupied");
  const git = async (...args: string[]) => (await run("git", ["-C", source, ...args], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 })).stdout;
  const head = (await git("rev-parse", "HEAD")).toString().trim();
  if (head !== manifest.sourceSha) throw new Error(`Source revision mismatch: expected ${manifest.sourceSha}, got ${head}`);
  const tree = new Map<string, { mode: string; oid: string }>();
  for (const entry of (await git("ls-tree", "-r", "-z", manifest.sourceSha)).toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, tab).split(" ");
    if (type === "blob") tree.set(entry.slice(tab + 1), { mode, oid });
  }
  // Complete all validation and blob reads before creating the destination.
  const blobs: Array<{ path: string; bytes: Buffer; mode: number; sha256: string }> = [];
  for (const path of manifest.files) {
    const entry = tree.get(path);
    if (!entry) throw new Error(`Manifest path is not tracked at source revision: ${path}`);
    if (entry.mode === "120000") throw new Error(`Tracked symlink rejected: ${path}`);
    if (!["100644", "100755"].includes(entry.mode)) throw new Error(`Unsupported file mode: ${path}`);
    await rejectSymlinks(join(source, path));
    const bytes = await git("cat-file", "blob", entry.oid);
    blobs.push({ path, bytes, mode: entry.mode === "100755" ? 0o755 : 0o644, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await mkdir(target, { recursive: true });
  for (const blob of blobs) {
    const destination = join(target, blob.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, blob.bytes, { flag: "wx", mode: blob.mode });
  }
  return { sourceSha: manifest.sourceSha, files: blobs.map(({ path, sha256 }) => ({ path, sha256 })) };
}

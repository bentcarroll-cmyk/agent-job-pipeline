import { Buffer } from "node:buffer";
import { lstat, realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { scanContent } from "./privacy-scan";
import { sha256, tar, validateFiles } from "./release-format";
// Resolve the operator-selected root once; reject symlinks in every archive member path.
async function regular(path: string): Promise<void> {
    const parent = dirname(path);
    if (parent !== path) await regular(parent);
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Symlink rejected");
}
export async function packageRelease(root: string, manifestPath: string, outputDir: string): Promise<{
    archive: string;
    sha256: string;
}> {
    root = await realpath(root);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    validateFiles(manifest.files);
    const entries: {
        path: string;
        bytes: Buffer;
    }[] = [];
    for (const path of [...manifest.files].sort()) {
        const source = join(root, path);
        await regular(source);
        if (!(await lstat(source)).isFile())
            throw new Error("Nonregular release file");
        const bytes = await readFile(source);
        const findings = scanContent(path, bytes);
        if (findings.length)
            throw new Error(JSON.stringify(findings));
        entries.push({ path, bytes });
    }
    const metadata = { schemaVersion: 1, stage: "candidate", files: entries.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) })) };
    entries.push({ path: "RELEASE-METADATA.json", bytes: Buffer.from(JSON.stringify(metadata, null, 2) + "\n") });
    const bytes = gzipSync(tar(entries), { level: 9 });
    const digest = sha256(bytes);
    await mkdir(outputDir, { recursive: true });
    const archive = join(outputDir, "agent-job-pipeline.tar.gz");
    await writeFile(archive, bytes);
    await writeFile(archive + ".sha256", digest + "  agent-job-pipeline.tar.gz\n");
    return { archive, sha256: digest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = resolve(process.argv[2] ?? "."), output = resolve(process.argv[3] ?? "release-output");
    console.log(JSON.stringify(await packageRelease(root, join(root, ".release/public-manifest.json"), output)));
}

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { scanContent } from "./privacy-scan";
import { sha256, tar, untar, validateFiles } from "./release-format";
export async function verifyRelease(archivePath: string): Promise<{
    passed: boolean;
    failures: readonly string[];
}> {
    const failures: string[] = [];
    try {
        const raw = await readFile(archivePath), checksum = (await readFile(archivePath + ".sha256", "utf8")).trim();
        if (checksum !== sha256(raw) + "  agent-job-pipeline.tar.gz")
            throw new Error("Archive checksum mismatch");
        const files = untar(gunzipSync(raw, { maxOutputLength: 128 * 1024 * 1024 }));
        const canonical = gzipSync(tar([...files].map(([path, bytes]) => ({ path, bytes }))), { level: 9 });
        if (raw.length !== canonical.length || !raw.every((byte: number, index: number) => byte === canonical[index]))
            throw new Error("Noncanonical archive metadata or padding");
        const manifest = JSON.parse(files.get(".release/public-manifest.json")!.toString());
        validateFiles(manifest.files);
        if (manifest.schemaVersion !== 1 || manifest.stage !== "candidate" || Object.keys(manifest).sort().join() !== "files,schemaVersion,stage")
            throw new Error("Invalid public manifest metadata");
        const metadataBytes = files.get("RELEASE-METADATA.json")!;
        failures.push(...scanContent("RELEASE-METADATA.json", metadataBytes).map(f => JSON.stringify(f)));
        const metadata = JSON.parse(metadataBytes.toString());
        if (metadata.schemaVersion !== 1 || metadata.stage !== "candidate" || Object.keys(metadata).sort().join() !== "files,schemaVersion,stage" || !Array.isArray(metadata.files))
            throw new Error("Invalid release metadata");
        if (files.size !== manifest.files.length + 1 || metadata.files.length !== manifest.files.length || new Set(metadata.files.map((f: {
            path: string;
        }) => f.path)).size !== manifest.files.length)
            throw new Error("Release membership mismatch");
        for (const path of manifest.files) {
            const bytes = files.get(path), entry = metadata.files.find((f: {
                path: string;
            }) => f.path === path);
            if (!bytes || !entry || entry.sha256 !== sha256(bytes))
                throw new Error("Release file hash mismatch");
            failures.push(...scanContent(path, bytes).map(f => JSON.stringify(f)));
        }
    }
    catch (error) {
        const codes: Record<string,string> = {
            "Archive checksum mismatch": "ARCHIVE_CHECKSUM_MISMATCH",
            "Noncanonical archive metadata or padding": "ARCHIVE_NONCANONICAL",
            "Invalid public manifest metadata": "ARCHIVE_MANIFEST_INVALID",
            "Invalid release metadata": "ARCHIVE_METADATA_INVALID",
            "Release membership mismatch": "ARCHIVE_MEMBERSHIP_MISMATCH",
            "Release file hash mismatch": "ARCHIVE_FILE_HASH_MISMATCH",
        };
        failures.push(codes[error instanceof Error ? error.message : ""] ?? "ARCHIVE_STRUCTURE_INVALID");
    }
    return { passed: failures.length === 0, failures };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await verifyRelease(resolve(process.argv[2] ?? "release-output/agent-job-pipeline.tar.gz"));
    console.log(JSON.stringify(result));
    if (!result.passed)
        process.exitCode = 1;
}

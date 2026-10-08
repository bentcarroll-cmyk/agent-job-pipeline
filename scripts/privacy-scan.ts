import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export type PrivacyFinding = {
    path: string;
    line: number | null;
    rule: string;
};
const identity = "Ben" + " Carroll";
const publicAuthor = identity + " <249464000+bentcarroll-cmyk@" + "users.noreply.github.com>";
const publicSenders: Record<string, readonly string[]> = {
    "src/lifecycle/decide.ts": ["calendar-notification@" + "google.com"],
    "src/lifecycle/evidence.ts": ["indeedapply@" + "indeed.com"],
    "src/lifecycle/gmail-client.ts": ["indeedapply@" + "indeed.com", "jobalerts-noreply@" + "linkedin.com"],
    "tests/lifecycle/instance.test.ts": ["indeedapply@" + "indeed.com"],
};
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
export function scanContent(path: string, bytes: Buffer | string, metadata = false): PrivacyFinding[] {
    const findings: PrivacyFinding[] = [];
    if (/(^|\/)(?:\.env(?:\.[^/]+)?|\.dev\.vars(?:\.[^/]+)?|credentials|\.superpowers|\.setup|snapshots|private|output|artifacts)(?:\/|$)|(?:career[_-](?:interview|notes)|production[-_]ledger)|\.(?:eml|mbox|pdf|docx|ttf|otf|woff2?|sqlite|db)$/i.test(path))
        findings.push({ path, line: null, rule: "private-artifact" });
    if (/(?:^|\/)(?:Career_Evidence\.md|resume\.json|letter\.json|materials\.json|oauth-client\.json)$/i.test(path))
        findings.push({ path, line: null, rule: "private-artifact" });
    const content = bytes.toString();
    if (content.includes("\0"))
        findings.push({ path, line: null, rule: "unreviewed-binary" });
    content.split(/\r?\n/).forEach((original, index) => {
        const line = metadata && original === publicAuthor ? "" : original;
        const add = (rule: string) => findings.push({ path, line: index + 1, rule });
        if (/(?:xox[baprs]-[A-Za-z0-9-]{12,}|sk-ant-[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(line))
            add("credential");
        if (/(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+\/|[A-Z]:\\Users\\[A-Za-z0-9_.-]+\\/.test(line))
            add("personal-home-path");
        if (new RegExp(["first production" + " run", "a real " + "example:", "one crash " + "left", "\\b\\d+[ -]minute run\\b"].join("|"), "i").test(line)) add("deployment-anecdote");
        const assignments = [...line.matchAll(/(?:api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|signing[_-]?secret)["']?\s*[:=]\s*["']([^"']{12,})["']/gi)];
        if (assignments.some(match => !/^(?:SYNTHETIC[-_]|SECRET[-_]|test[-_]|example[-_]|<)/i.test(match[1]))) add("credential");
        const phones = line.match(/(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g) ?? [];
        if (phones.some(phone => !/555[ .-]01\d{2}$/.test(phone))) add("personal-contact");
        const emails = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
        if (emails.some(email => !publicSenders[path]?.includes(email) && !/@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net|invalid|test)|[a-z0-9-]+\.(?:invalid|test))$/i.test(email)))
            add("personal-contact");
        if (line.includes(identity) && !(path === "LICENSE" && /^Copyright \(c\) 2026 /.test(line) && line === `Copyright (c) 2026 ${identity}. All rights reserved except as granted below.`))
            add("personal-identity");
    });
    return findings;
}
export async function scanPublicTree(root: string): Promise<readonly PrivacyFinding[]> {
    const findings: PrivacyFinding[] = [];
    for (const path of git(root, "ls-files", "-z").split("\0").filter(Boolean)) {
        try {
            const stat = await lstat(join(root, path));
            if (!stat.isFile()) {
                findings.push({ path, line: null, rule: "nonregular-file" });
                continue;
            }
            findings.push(...scanContent(path, await readFile(join(root, path))));
        }
        catch {
            findings.push({ path, line: null, rule: "missing-tracked-file" });
        }
    }
    return findings;
}
export async function scanPublicHistory(repoRoot: string): Promise<readonly PrivacyFinding[]> {
    const findings: PrivacyFinding[] = [];
    for (const sha of git(repoRoot, "rev-list", "--all").trim().split("\n").filter(Boolean)) {
        const meta = git(repoRoot, "show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", sha);
        const lines = meta.split("\n");
        findings.push(...scanContent(`${sha}:metadata`, lines.slice(0, 2).join("\n"), true));
        findings.push(...scanContent(`${sha}:message`, lines.slice(2).join("\n")));
        for (const record of git(repoRoot, "ls-tree", "-r", "-z", sha).split("\0").filter(Boolean)) {
            const [header, path] = record.split("\t"), [mode, type, oid] = header.split(" ");
            if (type !== "blob" || !["100644", "100755"].includes(mode)) {
                findings.push({ path: `${sha}:${path}`, line: null, rule: "nonregular-file" });
                continue;
            }
            const bytes = execFileSync("git", ["-C", repoRoot, "cat-file", "blob", oid], { maxBuffer: 64 * 1024 * 1024 });
            findings.push(...scanContent(path, bytes).map(f => ({ ...f, path: `${sha}:${f.path}` })));
        }
    }
    for (const entry of git(repoRoot, "for-each-ref", "--format=%(objecttype) %(objectname)", "refs/tags").trim().split("\n").filter(Boolean)) {
        const [type, oid] = entry.split(" ");
        if (type !== "tag")
            continue;
        const lines = git(repoRoot, "cat-file", "tag", oid).split("\n");
        const boundary = lines.indexOf("");
        for (const [index, line] of lines.entries()) {
            const tagger = index < boundary && line.startsWith("tagger ");
            const text = tagger ? line.slice(7).replace(/ \d+ [+-]\d{4}$/, "") : line;
            findings.push(...scanContent(`tag:${oid}:metadata`, text, tagger).map(f => ({ ...f, line: index + 1 })));
        }
    }
    return findings;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--root"), root = i < 0 ? process.cwd() : resolve(process.argv[i + 1]);
    const findings = [...await scanPublicTree(root), ...(process.argv.includes("--history") ? await scanPublicHistory(root) : [])];
    for (const f of findings)
        console.error(JSON.stringify(f));
    console.log(`Privacy findings: ${findings.length}`);
    if (findings.length)
        process.exitCode = 1;
}

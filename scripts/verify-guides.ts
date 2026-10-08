import { readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function verifyGuides(base = root, read: typeof readFile = readFile): Promise<void> {
  const files = ["README.md", "SETUP.md", "AGENTS.md", "CLAUDE.md", "docs/accounts.md", "docs/upgrades.md", "docs/recovery.md", "docs/setup.md", "docs/lifecycle-setup.md", ".agents/skills/job-materials/SKILL.md", ".claude/skills/job-materials/SKILL.md"];
  const cli = await read(resolve(base, "tools/setup/cli.ts"), "utf8");
  const commandList = cli.match(/if \(!\[([^\]]+)\]\.includes\(command\)\)/)?.[1];
  if (!commandList) throw new Error("GUIDE_CLI_COMMANDS_UNREADABLE");
  const flags = cli.match(/\^--\(([^)]+)\)\$/)?.[1].split("|");
  if (!flags) throw new Error("GUIDE_CLI_FLAGS_UNREADABLE");
  const commands = [...commandList.matchAll(/'([^']+)'/g)].map(m => m[1]); const seen = new Set<string>();
  for (const file of files) {
    let body: string; try { body = await read(resolve(base, file), "utf8"); } catch { throw new Error(`GUIDE_MISSING: ${file}`); }
    for (const link of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#|mailto:)/.test(link[1])) continue;
      await access(resolve(base, dirname(file), link[1].split("#")[0])).catch(() => { throw new Error(`GUIDE_LINK_MISSING: ${file}: ${link[1]}`); });
    }
    for (const match of body.matchAll(/node --import (?:tsx|\/absolute\/private\/workspace\/\.setup\/dependencies\/node_modules\/tsx\/dist\/loader\.mjs) tools\/setup\/cli\.ts ([a-z-]+)/g)) {
      if (!commands.includes(match[1])) throw new Error(`GUIDE_UNKNOWN_COMMAND: ${match[1]}`); seen.add(match[1]);
      const line = body.slice(match.index!, body.indexOf("\n", match.index!) < 0 ? undefined : body.indexOf("\n", match.index!));
      for (const flag of line.slice(line.indexOf("tools/setup/cli.ts") + "tools/setup/cli.ts".length).matchAll(/--([a-z-]+) /g)) if (!flags.includes(flag[1])) throw new Error(`GUIDE_UNKNOWN_FLAG: ${flag[1]}`);
      if (!line.includes("--workspace /absolute/private/workspace") || !line.includes("--instance /absolute/private/workspace/instance.json")) throw new Error(`GUIDE_WORKSPACE_EXAMPLE: ${file}`);
    }
    if (/YOUR[_ -](?:TOKEN|KEY)|sk-[a-zA-Z0-9]{20}|\/Users\/[a-zA-Z0-9_-]+|RADAR_PROFILE_NOT_AVAILABLE/.test(body)) throw new Error(`GUIDE_PRIVATE_OR_STALE_EXAMPLE: ${file}`);
    if (file.endsWith("job-materials/SKILL.md")) {
      const canonical = "../../../skills/prepare-application/SKILL.md";
      if (!body.includes(`](${canonical})`) || body.length > 1800 || !body.startsWith("---\nname: job-materials\ndescription:")) throw new Error(`GUIDE_ADAPTER_NOT_CANONICAL: ${file}`);
    }
    if (file === "CLAUDE.md" && !body.includes("@AGENTS.md")) throw new Error("GUIDE_CLAUDE_IMPORT_MISSING");
  }
  for (const command of commands) if (!seen.has(command)) throw new Error(`GUIDE_COMMAND_UNDOCUMENTED: ${command}`);
  const version = JSON.parse(await read(resolve(base, "package.json"), "utf8")).version;
  if (version !== "0.1.0-beta.1") throw new Error("GUIDE_RELEASE_VERSION_MISMATCH");
  const prompt = `> Set up Agent Job Pipeline from https://github.com/bentcarroll-cmyk/agent-job-pipeline at the reviewed v${version} prerelease.`;
  for (const file of ["README.md", "SETUP.md", "docs/release-notes.md"]) {
    const body = await read(resolve(base, file), "utf8");
    if (!body.includes(prompt) || body.includes("https://example.invalid/your-org/agent-job-pipeline")) throw new Error(`GUIDE_RELEASE_PROMPT_MISMATCH: ${file}`);
  }
  const setup = await read(resolve(base, "SETUP.md"), "utf8");
  for (const needed of ["candidate.json", "criteria.md", "materials.json", "activation-review.json", "offline", "Codex", "Claude"]) if (!setup.includes(needed)) throw new Error(`GUIDE_SETUP_MISSING: ${needed}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifyGuides().then(() => process.stdout.write("guides: links, adapters, setup commands and reviewed beta prompts verified\n"), error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });

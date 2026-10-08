import {it, expect} from "vitest";
import {readFile} from "node:fs/promises";
import {verifyGuides} from "../../scripts/verify-guides";
const root = new URL("../..",import.meta.url).pathname;
it.each([[
  "bad command", "node --import tsx tools/setup/cli.ts destroy --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json", "GUIDE_UNKNOWN_COMMAND"
], [
  "bad flag", "node --import tsx tools/setup/cli.ts status --workspace /absolute/private/workspace --instance /absolute/private/workspace/instance.json --deploy approved", "GUIDE_UNKNOWN_FLAG"
], [
  "bad adapter link", "", "GUIDE_ADAPTER_NOT_CANONICAL"
]])("guide checker rejects %s",async (name,line,error)=>{
  const read = (async (path: Parameters<typeof readFile>[0], options: any) => {
    const body = (await readFile(path,options)).toString();
    if (String(path).endsWith("/SETUP.md") && line) return body + "\n" + line + "\n";
    if (name === "bad adapter link" && String(path).endsWith("/.agents/skills/job-materials/SKILL.md")) return body.replace("../../../skills/prepare-application/SKILL.md", "../../../skills/onboard/SKILL.md");
    return body;
  }) as typeof readFile;
  await expect(verifyGuides(root,read)).rejects.toThrow(error);
});

import {it, expect, afterEach, vi} from "vitest";
import {mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {bootstrap} from "../../tools/setup/bootstrap.mjs";
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "bootstrap-test-")); roots.push(path); return realpath(path); }
afterEach(async () => {for (const path of roots.splice(0)) await rm(path, {recursive: true, force: true});});
it("core bootstrap uses selected private lock/config/cache and preserves HOME without exposing inherited secrets", async () => {
  const path = await root(), run = vi.fn().mockResolvedValue({stdout: "", stderr: ""});
  const result = await bootstrap(path, run);
  expect(result.loader).toBe(join(path, ".setup/dependencies/node_modules/tsx/dist/loader.mjs"));
  const options = run.mock.calls[0][2]; expect(options.cwd).toBe(join(path, ".setup/dependencies"));
  expect(options.env.HOME).toBe(process.env.HOME); expect(options.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  expect(options.env.NPM_CONFIG_USERCONFIG).toBe(join(path, ".setup/npmrc"));
  expect(await readFile(join(path, ".setup/dependencies/package-lock.json"), "utf8")).toBe(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  expect(run.mock.calls[0][1]).toContain("--ignore-scripts");
});
it("core bootstrap refuses existing locks and escaped destinations before npm", async () => {
  const path = await root(), outside = await root(), run = vi.fn();
  await mkdir(join(path, ".setup"), {mode: 0o700}); await writeFile(join(path, ".setup/lock"), "busy");
  await expect(bootstrap(path, run)).rejects.toThrow("SETUP_LOCKED");
  await rm(join(path, ".setup/lock")); await symlink(outside, join(path, ".setup/dependencies"));
  await expect(bootstrap(path, run)).rejects.toThrow("UNSAFE_SETUP_PATH"); expect(run).not.toHaveBeenCalled();
});

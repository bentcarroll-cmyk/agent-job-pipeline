// Core Node only: usable before tsx or checkout-local dependencies exist.
import { realpath, readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {assertWorkspace,setupDirectory,setupPath,validateSetupTree,withWorkspaceLock,atomicPrivateWrite,SetupError} from "./core-guards.mjs";
const fail = code => {throw new SetupError(code);};
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function bootstrap(workspace, run = exec) {
  if (!/^22\./.test(process.versions.node)) fail("NODE_22_REQUIRED");
  if (process.platform !== "darwin") fail("PLATFORM_NOT_VALIDATED");
  if (!isAbsolute(workspace)) fail("ABSOLUTE_WORKSPACE_REQUIRED");
  // Core and TypeScript CLIs share identical workspace/path/tree/lock guards.
  const root = await assertWorkspace(workspace, [releaseRoot, resolve(releaseRoot, "../glm-agent-pipeline")]);
  await realpath(root); // Root must already be selected/created by the operator.
  const setup = await setupDirectory(root);
  await validateSetupTree(root);
  return withWorkspaceLock(root, async () => {
    const dependencies = await setupPath(root, "dependencies", "directory", true);
    for (const name of ["package.json", "package-lock.json"]) await atomicPrivateWrite(root, join(dependencies, name), await readFile(join(releaseRoot, name)));
    for (const name of ["npmrc", "npm-globalrc", "dependencies/.npmrc"]) await atomicPrivateWrite(root, await setupPath(root, name), "");
    const environment = {PATH: process.env.PATH, HOME: process.env.HOME,
      NPM_CONFIG_USERCONFIG: join(setup, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(setup, "npm-globalrc"),
      NPM_CONFIG_CACHE: await setupPath(root, "npm-cache", "directory", true), TMPDIR: await setupPath(root, "tmp", "directory", true)};
    await validateSetupTree(root);
    await run(process.execPath, [join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {cwd: dependencies, env: environment, maxBuffer: 2 * 1024 * 1024});
    await validateSetupTree(root);
    return {ok: true, loader: join(dependencies, "node_modules/tsx/dist/loader.mjs")};
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--workspace") { process.stderr.write("Usage: node tools/setup/bootstrap.mjs --workspace /absolute/private/workspace\n"); process.exitCode = 1; }
  else await bootstrap(args[1]).then(result => process.stdout.write(JSON.stringify(result) + "\n"), () => { process.stderr.write("Bootstrap failed; verify Node 22, the selected external workspace, setup lock/paths and network dependencies.\n"); process.exitCode = 1; });
}

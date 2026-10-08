import { readFile, copyFile, access } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRuntimeConfig } from '../../src/config/candidate';
import { isOutside, setupPath, validateSetupTree, atomicPrivateWrite } from './state';
import { SetupError } from './types';
const exec = promisify(execFile);
export const hashBytes = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export {assertWorkspace,privatePath} from './core-guards.mjs';
import {privatePath} from './core-guards.mjs';
export async function loadApprovedProfile(root: string) {
    const runtime = await loadRuntimeConfig(JSON.parse(await readFile(await privatePath(root, 'candidate.json'), 'utf8')));
    const readable = await readFile(await privatePath(root, 'criteria.md'));
    if (hashBytes(readable) !== runtime.candidate.approval.readableSha256)
        throw new SetupError('READABLE_APPROVAL_MISMATCH');
    return runtime;
}
export type Capabilities = {
    node: string;
    python: string;
    documents: boolean;
    fonts: boolean;
    platform: string;
};
export async function checkCapabilities(c: Capabilities): Promise<string[]> {
    return [
        ...(/^22\./.test(c.node) ? [] : ['NODE_22_REQUIRED']), ...(/^3\.12\./.test(c.python) ? [] : ['PYTHON_312_REQUIRED']),
        ...(c.documents ? [] : ['DOCUMENT_CAPABILITY_MISSING']), ...(c.fonts ? [] : ['FONT_CAPABILITY_MISSING']), ...(c.platform === 'darwin' ? [] : ['PLATFORM_NOT_VALIDATED'])
    ];
}
/** Selected-workspace dependencies only. npm verifies lock integrity; pip check and real PDF render/import probes verify capabilities. */
export async function prepareDependencies(root: string, releaseRoot: string, pythonExecutable: string) {
    if (process.platform !== 'darwin')
        throw new SetupError('PLATFORM_NOT_VALIDATED');
    if (!/^22\./.test(process.versions.node))
        throw new SetupError('NODE_22_REQUIRED');
    await validateSetupTree(root);
    const target = await setupPath(root, 'dependencies', 'directory', true);
    const environment = await dependencyEnvironment(root);
    // npm also reads project config; own that file as well as both user/global configs.
    for (const file of ['npmrc', 'npm-globalrc', 'dependencies/.npmrc'])
        await atomicPrivateWrite(root, await setupPath(root, file), '');
    for (const file of ['package.json', 'package-lock.json'])
        await copyFile(join(releaseRoot, file), await setupPath(root, 'dependencies/' + file));
    try {
        const { stdout } = await exec(pythonExecutable, ['-I', '-c', 'import sys;print(".".join(map(str,sys.version_info[:3])))'], { env: environment });
        if (!stdout.startsWith('3.12.'))
            throw new Error();
    }
    catch {
        throw new SetupError('PYTHON_312_REQUIRED');
    }
    try {
        await exec(process.execPath, [join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, env: environment, maxBuffer: 1024 * 1024 });
    }
    catch {
        throw new SetupError('NODE_DEPENDENCY_INSTALL_FAILED');
    }
    const venv = await setupPath(root, 'python', 'directory', true);
    try {
        await exec(pythonExecutable, ['-I', '-m', 'venv', '--copies', venv], { env: environment });
        await validateSetupTree(root);
        await exec(await setupPath(root, 'python/bin/python'), ['-I', '-m', 'pip', '--isolated', 'install', '--cache-dir', await setupPath(root, 'pip-cache', 'directory', true), '--disable-pip-version-check', '-r', join(releaseRoot, 'tools/materials/requirements-macos-py312.lock')], { env: environment, maxBuffer: 1024 * 1024 });
        await exec(await setupPath(root, 'python/bin/python'), ['-I', '-m', 'pip', '--isolated', 'check'], { env: environment });
    }
    catch {
        throw new SetupError('PYTHON_DEPENDENCY_INSTALL_FAILED');
    }
    return probeDependencies(root, releaseRoot);
}
export async function probeDependencies(root: string, releaseRoot?: string) {
    await validateSetupTree(root);
    const environment = await dependencyEnvironment(root);
    if (releaseRoot) {
        const selected = await readFile(await setupPath(root, 'dependencies/package-lock.json'));
        if (hashBytes(selected) !== hashBytes(await readFile(join(releaseRoot, 'package-lock.json'))))
            throw new SetupError('NODE_LOCK_CHANGED');
        try {
            await exec(process.execPath, [join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), 'ls', '--all', '--json'], { cwd: await setupPath(root, 'dependencies', 'directory'), env: environment, maxBuffer: 2 * 1024 * 1024 });
        }
        catch {
            throw new SetupError('NODE_DEPENDENCIES_UNVERIFIED');
        }
    }
    const python = await setupPath(root, 'python/bin/python');
    try {
        for (const font of ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'])
            await access(font);
    }
    catch {
        throw new SetupError('FONT_CAPABILITY_MISSING');
    }
    try {
        const { stdout } = await exec(python, ['-I', '-c', `import sys,json,io,os,importlib.metadata\nfrom reportlab.pdfgen.canvas import Canvas\nfrom pypdf import PdfReader\nimport pdfplumber,pypdfium2\nfrom reportlab.pdfbase import pdfmetrics\nfrom reportlab.pdfbase.ttfonts import TTFont\npdfmetrics.registerFont(TTFont('SetupArial','/System/Library/Fonts/Supplemental/Arial.ttf'))\nb=io.BytesIO();c=Canvas(b);c.setFont('SetupArial',12);c.drawString(40,40,'Synthetic document capability');c.save();b.seek(0);p=PdfReader(b);assert len(p.pages)==1;assert 'Synthetic' in p.pages[0].extract_text();render=pypdfium2.PdfDocument(b.getvalue());assert render[0].render().to_pil().width>0\nprint(json.dumps(dict(node='${process.versions.node}',python='.'.join(map(str,sys.version_info[:3])),documents=True,fonts=all(os.path.isfile(p) for p in ['/System/Library/Fonts/Supplemental/Arial.ttf','/System/Library/Fonts/Supplemental/Arial Bold.ttf']),platform=sys.platform)))`], { env: environment });
        const capabilities = JSON.parse(stdout) as Capabilities;
        const missing = await checkCapabilities(capabilities);
        if (missing.length)
            throw new SetupError(missing[0]);
        return capabilities;
    }
    catch (e) {
        if (e instanceof SetupError)
            throw e;
        throw new SetupError('DOCUMENT_CAPABILITY_MISSING');
    }
}

/** HOME is preserved; no inherited tokens, proxy, npm or Python configuration enters these tools. */
export async function dependencyEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
    return { PATH: process.env.PATH, HOME: process.env.HOME,
        NPM_CONFIG_USERCONFIG: await setupPath(root, 'npmrc'),
        NPM_CONFIG_GLOBALCONFIG: await setupPath(root, 'npm-globalrc'),
        NPM_CONFIG_CACHE: await setupPath(root, 'npm-cache', 'directory', true),
        PIP_CONFIG_FILE: '/dev/null', PYTHONNOUSERSITE: '1',
        TMPDIR: await setupPath(root, 'tmp', 'directory', true) };
}

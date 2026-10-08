import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export async function findUnresolvedImports(root: string, files: readonly string[]): Promise<{ path: string; specifier: string }[]> {
  const unresolved: { path: string; specifier: string }[] = [];
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, resolveJsonModule: true, allowJs: true };
  for (const path of files.filter(path => /\.[cm]?[jt]sx?$/.test(path))) {
    const filename = resolve(root, path);
    const source = ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const specifiers = new Set<string>();
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.add(node.arguments[0].text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifiers.add(node.argument.literal.text);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) specifiers.add(node.moduleReference.expression.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of specifiers) {
      if (isBuiltin(specifier) || specifier === "cloudflare:workers") continue;
      if (!ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule) unresolved.push({ path, specifier });
    }
  }
  return unresolved;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(resolve(root, ".release/public-manifest.json"), "utf8")) as { files: string[] };
  const unresolved = await findUnresolvedImports(root, manifest.files);
  for (const item of unresolved) console.error(`${item.path}: unresolved ${item.specifier}`);
  console.log(`Runtime import closure: ${unresolved.length} unresolved imports (${manifest.files.filter(path => /\.[cm]?[jt]sx?$/.test(path)).length} selected TypeScript files)`);
  if (unresolved.length) process.exitCode = 1;
}

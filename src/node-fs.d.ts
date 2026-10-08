// Minimal ambient declaration for the one Node builtin src/fetch-job.test.ts
// needs (`readFileSync`, to read source files as text for the runtime-
// independence check). Deliberately not @types/node: that package's
// index.d.ts triple-slash-references a global (non-module) script of
// ambient Node globals (process, Buffer, require, __dirname, Node's own
// fetch/Request/Response, ...) which, once loaded, applies to the whole
// `tsc` program rather than just the importing file — tsconfig.json's
// Workers-only `"types"` array only blocks *automatic* inclusion of
// @types/* packages, not the module resolution that an explicit
// `import ... from "node:fs"` triggers. Pulling that in would silently
// erase the exact Workers/Node type separation this task's split into
// src/fetch-job.ts exists to preserve. This shim covers only the one
// function actually used, nothing else.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

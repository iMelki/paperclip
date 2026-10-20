// Five repo-owned TypeScript files only; no tsx/esbuild subprocess or generic remap.
import { createRequire } from "node:module";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "scripts/ensure-workspace-package-links.ts",
  "packages/db/src/check-migration-numbering.ts",
  "packages/db/src/check-migration-safety.ts",
  "packages/db/src/migration-safety-baseline.ts",
  "packages/db/src/table-size-estimates.ts",
];
const inside = (base, file) => { const relative=path.relative(base,file);return relative!=="" && relative!==".." && !relative.startsWith(".."+path.sep) && !path.isAbsolute(relative); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bindings = new Map(files.map(relative => {
  const lexical=path.join(root,relative),real=realpathSync(lexical);
  if(!inside(root,real)||!statSync(real).isFile()||(process.platform==="win32"?real.toLowerCase():real)!==(process.platform==="win32"?lexical.toLowerCase():lexical))throw new Error("Gate TS source must be its exact contained regular file");
  return [pathToFileURL(real).href,{real,hash:hash(readFileSync(real))}];
}));
const safetyUrl=pathToFileURL(realpathSync(path.join(root,"packages/db/src/check-migration-safety.ts"))).href;
const maps=new Map([
  ["./migration-safety-baseline.js",pathToFileURL(realpathSync(path.join(root,"packages/db/src/migration-safety-baseline.ts"))).href],
  ["./table-size-estimates.js",pathToFileURL(realpathSync(path.join(root,"packages/db/src/table-size-estimates.ts"))).href],
]);
const require=createRequire(import.meta.url);
const manifestPath=realpathSync(require.resolve("typescript/package.json"));
const manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);
if(manifest.name!=="typescript"||manifest.version!=="5.9.3")throw new Error("Gate TS loader requires qualified TypeScript 5.9.3");
const apiPath=realpathSync(path.join(path.dirname(manifestPath),"lib/typescript.js"));
if(!inside(path.dirname(manifestPath),apiPath)||!statSync(apiPath).isFile())throw new Error("Gate TS compiler API escaped its package");
const apiHash=hash(readFileSync(apiPath)),manifestHash=hash(manifestBytes);
const ts=require(apiPath);

export async function resolve(specifier, context, nextResolve) {
  if(context.parentURL===safetyUrl&&maps.has(specifier))return {url:maps.get(specifier),shortCircuit:true};
  const result=await nextResolve(specifier,context);
  if(/\.(?:[mc]?ts|tsx)(?:[?#]|$)/u.test(result.url) && !bindings.has(result.url))throw new Error("Gate TS loader refuses an unqualified TypeScript module");
  return result;
}

export async function load(url, context, nextLoad) {
  const binding=bindings.get(url);
  if(!binding){if(/\.(?:[mc]?ts|tsx)(?:[?#]|$)/u.test(url))throw new Error("Gate TS loader refuses an unqualified TypeScript module");return await nextLoad(url,context);}
  const bytes=readFileSync(binding.real);
  if(hash(bytes)!==binding.hash||hash(readFileSync(apiPath))!==apiHash||hash(readFileSync(manifestPath))!==manifestHash)throw new Error("Gate TS source/compiler changed after qualification");
  const result=ts.transpileModule(bytes.toString("utf8"),{
    fileName:binding.real,reportDiagnostics:true,
    compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023,verbatimModuleSyntax:false,sourceMap:false,inlineSourceMap:false},
  });
  const errors=(result.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errors.length)throw new Error("Gate TS transpilation failed: "+errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("; "));
  // Keep the original .ts URL and CLI argv[1]; the migration-safety main guard
  // must execute the real CLI, never a wrapper that only imports its functions.
  return {format:"module",source:result.outputText,shortCircuit:true};
}

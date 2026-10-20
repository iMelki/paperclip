#!/usr/bin/env node
// Exact supported gate tasks only: pnpm is metadata LIST, never lifecycle RUN.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync, statSync, appendFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeExecutable, runGateChild } from "./gate-child.mjs";
import { resolvePnpmCli } from "./resolve-pnpm-cli.mjs";
import { resolveGitLocalEnvironmentVariableNames, sanitizeGitLocalEnvironment } from "./git-local-env.mjs";
import { isMainModule } from "./is-main-module.mjs";
import core from "./check-forbidden-tokens-core.cjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const inside=(base,file)=>{const r=path.relative(base,file);return r!==""&&r!==".."&&!r.startsWith(".."+path.sep)&&!path.isAbsolute(r);};
const normalize=value=>process.platform==="win32"?value.toLowerCase():value;
function pin(file){const real=realpathSync(file);if(!statSync(real).isFile())throw new Error("Expected regular gate input");return {file:real,hash:hash(readFileSync(real))};}
function unchanged(binding){if(hash(readFileSync(binding.file))!==binding.hash)throw new Error("Qualified gate input changed before task launch");}
function source(relative){const lexical=path.join(root,relative),real=realpathSync(lexical);if(!inside(root,real)||normalize(real)!==normalize(lexical))throw new Error("Gate source must be its exact repo-owned file");return pin(real);}
function pnpmCommand(env){for(const dir of (env.PATH??env.Path??"").split(path.delimiter)){if(!dir||!path.isAbsolute(dir))continue;for(const name of process.platform==="win32"?["pnpm.cmd","pnpm.exe"]:["pnpm"]){const f=path.join(dir,name);try{if(statSync(f).isFile())return f;}catch{/* metadata only */}}}return undefined;}
export function qualifyCompiler(packageDirectory){
  const require=createRequire(path.join(packageDirectory,"package.json"));
  const manifest=pin(require.resolve("typescript/package.json"));
  const metadata=JSON.parse(readFileSync(manifest.file,"utf8"));
  if(metadata.name!=="typescript"||metadata.version!=="5.9.3"||metadata.bin?.tsc!=="./bin/tsc"&&metadata.bin?.tsc!=="bin/tsc")throw new Error("Gate requires qualified TypeScript5.9.3 compiler");
  const bin=pin(path.resolve(path.dirname(manifest.file),metadata.bin.tsc));
  const api=pin(path.join(path.dirname(manifest.file),"lib/typescript.js"));
  if(!inside(path.dirname(manifest.file),bin.file)||!inside(path.dirname(manifest.file),api.file))throw new Error("Compiler bin/API escaped its package");
  const shim=pin(path.join(path.dirname(manifest.file),"lib/tsc.js")),body=pin(path.join(path.dirname(manifest.file),"lib/_tsc.js"));
  if(!inside(path.dirname(manifest.file),shim.file)||!inside(path.dirname(manifest.file),body.file))throw new Error("Compiler load chain escaped its package");
  return {manifest,bin,api,shim,body};
}
function noEvents(manifest,event){for(const key of ["pre"+event,"post"+event])if(manifest.scripts?.[key])throw new Error("Gate refuses unqualified lifecycle event "+key);}
const plain=new Map([["tsc --noEmit",["--noEmit"]],["tsc -b",["-b"]],["tsc -p tsconfig.json --noEmit",["-p","tsconfig.json","--noEmit"]]]);
const sdkPrefix="pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && ";
export function planTypecheck(member){
  const {name,relativePath,manifest}=member;noEvents(manifest,"typecheck");
  const script=manifest.scripts?.typecheck;if(typeof script!=="string")throw new Error("Workspace has no qualified typecheck script: "+name);
  let suffix=script;const steps=[];
  if(suffix.startsWith(sdkPrefix)){steps.push({kind:"source",relative:"scripts/ensure-plugin-build-deps.mjs",cwd:"packages/plugins/sdk",args:[]});suffix=suffix.slice(sdkPrefix.length);}
  if(name==="@paperclipai/plugin-sdk"&&suffix.startsWith("pnpm --filter @paperclipai/shared build && ")){steps.push({kind:"shared-build",cwd:"packages/shared",args:[]});suffix=suffix.slice("pnpm --filter @paperclipai/shared build && ".length);}
  if(name==="@paperclipai/db"&&suffix.startsWith("pnpm run check:migrations && ")){if(manifest.scripts?.["check:migrations"]!=="tsx src/check-migration-numbering.ts && tsx src/check-migration-safety.ts")throw new Error("Migration gate script changed");noEvents(manifest,"check:migrations");steps.push({kind:"typescript",relative:"packages/db/src/check-migration-numbering.ts",cwd:relativePath,args:[]},{kind:"typescript",relative:"packages/db/src/check-migration-safety.ts",cwd:relativePath,args:[]});suffix=suffix.slice("pnpm run check:migrations && ".length);}
  if(name==="@paperclipai/adapter-utils"&&suffix.startsWith("node ./scripts/ssh-command-lookup-gate.mjs && ")){steps.push({kind:"source",relative:"packages/adapter-utils/scripts/ssh-command-lookup-gate.mjs",cwd:relativePath,args:[]});suffix=suffix.slice("node ./scripts/ssh-command-lookup-gate.mjs && ".length);}
  const second=" && tsc --noEmit -p tsconfig.test.json";
  const extra=name==="@paperclipai/plugin-workspace-diff"&&suffix.endsWith(second);if(extra)suffix=suffix.slice(0,-second.length);
  const flags=plain.get(suffix);if(!flags)throw new Error("Unsupported typecheck script: "+name);
  steps.push({kind:"compiler",cwd:relativePath,args:[...flags]});if(extra)steps.push({kind:"compiler",cwd:relativePath,args:["--noEmit","-p","tsconfig.test.json"]});
  return steps;
}
export function dependencyOrder(members){
  const byName=new Map(members.map(m=>[m.name,m]));if(byName.size!==members.length)throw new Error("Duplicate workspace identity");
  const pending=new Set(byName.keys()),ordered=[];
  while(pending.size){const layer=[...pending].filter(name=>Object.keys({...byName.get(name).manifest.dependencies,...byName.get(name).manifest.devDependencies,...byName.get(name).manifest.optionalDependencies}).filter(dep=>byName.has(dep)).every(dep=>!pending.has(dep))).sort();if(!layer.length)throw new Error("Workspace dependency cycle cannot be silently omitted");for(const name of layer){ordered.push(byName.get(name));pending.delete(name);}}
  return ordered;
}
export async function runPreparedStep(step,{run=runGateChild,env=process.env}={}){
  for(const binding of step.pins)unchanged(binding);
  const result=await run(process.execPath,step.args,{cwd:step.cwd,env});if(result.error)throw result.error;return result.status??2;
}
export async function queryMembers(filters=[],{run=runGateChild,env=process.env,repoRoot=root,bindingResolver=resolvePnpmCli}={}){
  const binding=bindingResolver({repoRoot,selectedCommand:pnpmCommand(env),env});
  const manifest=pin(binding.manifest),cli=pin(binding.cli);unchanged(manifest);unchanged(cli);
  const args=[binding.cli,...filters.flatMap(filter=>["--filter",filter]),"list","-r","--depth","-1","--json"];
  const result=await run(process.execPath,args,{cwd:repoRoot,env,capture:true,timeoutMs:120000});if(result.error||result.status!==0)throw result.error??new Error("Authoritative pnpm LIST failed");
  let values;try{values=JSON.parse(result.stdout);}catch{throw new Error("Authoritative pnpm LIST JSON is invalid");}
  if(!Array.isArray(values)||!values.length||values.length>128)throw new Error("Authoritative workspace membership is empty or oversized");
  const names=new Set(),directories=new Set(),members=[];
  const rootIdentity=realpathSync(repoRoot),rootName=JSON.parse(readFileSync(path.join(rootIdentity,"package.json"),"utf8")).name;
  for(const item of values){
    if(!item||typeof item!=="object"||typeof item.name!=="string"||!item.name||typeof item.path!=="string"||!path.isAbsolute(item.path))throw new Error("Invalid authoritative workspace identity");
    const dir=realpathSync(item.path),key=normalize(dir);
    if(directories.has(key))throw new Error("Duplicate authoritative workspace directory");directories.add(key);
    if(normalize(dir)!==normalize(path.resolve(item.path)))throw new Error("Workspace path is not its exact source identity");
    if(normalize(dir)===normalize(rootIdentity)){if(item.name!==rootName)throw new Error("Root LIST identity does not match its manifest");continue;}
    const relativePath=path.relative(rootIdentity,dir).split(path.sep).join("/");
    if(!inside(rootIdentity,dir)||relativePath.startsWith("packages/plugins/sandbox-providers/")||relativePath==="packages/plugins/sandbox-providers"||relativePath==="packages/plugins/examples/plugin-orchestration-smoke-example")throw new Error("Workspace membership escaped/excluded source");
    if(names.has(item.name))throw new Error("Duplicate authoritative workspace name");names.add(item.name);
    const manifestPin=pin(path.join(dir,"package.json")),manifest=JSON.parse(readFileSync(manifestPin.file,"utf8"));if(manifest.name!==item.name)throw new Error("Workspace name does not match manifest");
    members.push({name:item.name,relativePath,directory:dir,manifest,manifestPin});
  }
  if(!members.length)throw new Error("Authoritative LIST contains no qualified workspace members");
  return members;
}
export function discoverDeclaredWorkspaces(repoRoot=root){
  const rootIdentity=realpathSync(repoRoot),configuration=pin(path.join(rootIdentity,"pnpm-workspace.yaml"));
  const lines=readFileSync(configuration.file,"utf8").split(/\r?\n/u).map(line=>line.trim()).filter(line=>line&&!line.startsWith("#"));
  if(lines.shift()!=="packages:")throw new Error("Unsupported workspace configuration grammar");
  const patterns=lines.map(line=>{const match=/^-\s+(?:"([^"]+)"|'([^']+)'|([^#"']+))(?:\s+#.*)?$/u.exec(line);if(!match)throw new Error("Unsupported workspace declaration grammar");return (match[1]??match[2]??match[3]).trim();});
  if(!patterns.length||patterns.length>32)throw new Error("Workspace declaration count is invalid");
  const positives=[],exclusions=[];
  for(const raw of patterns){const negative=raw.startsWith("!"),pattern=negative?raw.slice(1):raw;
    if(!/^[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)*(?:\/\*{1,2})?$/u.test(pattern)||pattern.split("/").includes("..")||(!negative&&pattern.endsWith("/**")))throw new Error("Unsupported workspace glob grammar");
    (negative?exclusions:positives).push(pattern);
  }
  if(!positives.length)throw new Error("Workspace has no positive declarations");
  const excluded=relative=>exclusions.some(pattern=>pattern.endsWith("/**")?relative===pattern.slice(0,-3)||relative.startsWith(pattern.slice(0,-3)+"/"):relative===pattern);
  const relativePaths=new Set();
  for(const pattern of positives){if(pattern.endsWith("/*")){
    const base=pattern.slice(0,-2),directory=path.join(rootIdentity,base),realDirectory=realpathSync(directory);
    if(!inside(rootIdentity,realDirectory)||normalize(directory)!==normalize(realDirectory))throw new Error("Workspace glob directory escaped its source identity");
    const entries=readdirSync(directory,{withFileTypes:true});
    if(entries.length>512)throw new Error("Workspace directory enumeration exceeded its bound");
    for(const entry of entries){if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;const relative=base+"/"+entry.name;if(excluded(relative))continue;if(entry.isSymbolicLink())throw new Error("Workspace glob refuses linked source directories");if(existsSync(path.join(rootIdentity,relative,"package.json")))relativePaths.add(relative);}
  }else{if(!excluded(pattern)){if(!existsSync(path.join(rootIdentity,pattern,"package.json")))throw new Error("Declared literal workspace manifest is missing");relativePaths.add(pattern);}}}
  if(!relativePaths.size||relativePaths.size>128)throw new Error("Declared workspace inventory is empty or oversized");
  const names=new Set(),members=[];
  for(const relativePath of [...relativePaths].sort()){
    const lexical=path.join(rootIdentity,relativePath),directory=realpathSync(lexical);
    if(!inside(rootIdentity,directory)||normalize(directory)!==normalize(lexical))throw new Error("Declared workspace source identity escaped");
    const manifestPin=pin(path.join(directory,"package.json")),manifest=JSON.parse(readFileSync(manifestPin.file,"utf8"));
    if(typeof manifest.name!=="string"||!manifest.name||names.has(manifest.name))throw new Error("Declared workspace identity is missing or duplicated");names.add(manifest.name);
    members.push({name:manifest.name,relativePath,directory,manifest,manifestPin});
  }
  return {configuration,members};
}
function assertCompleteMembership(actual,declared){
  const expected=new Map(declared.map(member=>[normalize(member.directory),member]));
  if(actual.length!==expected.size)throw new Error("Full pnpm LIST is not complete against declared workspace inventory");
  for(const member of actual){const known=expected.get(normalize(member.directory));if(!known||known.name!==member.name||known.manifestPin.hash!==member.manifestPin.hash)throw new Error("Full pnpm LIST has unknown or changed declared workspace identity");}
}

function rootContract(manifest){
  const exact={"check:tokens":"node scripts/check-forbidden-tokens.mjs","preflight:workspace-links":"node cli/node_modules/tsx/dist/cli.mjs scripts/ensure-workspace-package-links.ts","test:run":"pnpm run preflight:workspace-links && node scripts/run-vitest-stable.mjs"};
  for(const [event,script]of Object.entries(exact)){if(manifest.scripts?.[event]!==script)throw new Error("Root gate script changed: "+event);noEvents(manifest,event);}
}
function tsStep(relative,cwd,pins){const loader=source("scripts/gate-typescript-loader.mjs"),entry=source(relative);return {cwd,args:["--loader",loader.file,entry.file],pins:[...pins,loader,entry]};}
export async function executeWorkspaceTypechecks(filters=[],options={}){
  const declared=discoverDeclaredWorkspaces(options.repoRoot??root);
  const all=await queryMembers([],options);assertCompleteMembership(all,declared.members);
  const byName=new Map(all.map(m=>[m.name,m]));
  const prepared=new Map();
  // Qualify ALL scripts/inputs before any check child, even for a filtered run.
  for(const member of all){const compiler=qualifyCompiler(member.directory),steps=planTypecheck(member),pins=[member.manifestPin,compiler.manifest,compiler.bin,compiler.api,compiler.shim,compiler.body];prepared.set(member.name,steps.map(step=>{
    const cwd=path.join(root,step.cwd);
    if(step.kind==="compiler")return {cwd,args:[compiler.bin.file,...step.args],pins};
    if(step.kind==="typescript")return tsStep(step.relative,cwd,pins);
    if(step.kind==="shared-build"){const shared=byName.get("@paperclipai/shared");if(!shared||shared.manifest.scripts?.build!=="tsc")throw new Error("Shared build contract changed");noEvents(shared.manifest,"build");const tool=qualifyCompiler(shared.directory);return {cwd,args:[tool.bin.file],pins:[...pins,shared.manifestPin,tool.manifest,tool.bin,tool.api,tool.shim,tool.body]};}
    const sdk=byName.get("@paperclipai/plugin-sdk");if(step.relative==="scripts/ensure-plugin-build-deps.mjs"){if(!sdk||sdk.manifest.scripts?.["ensure-build-deps"]!=="node ../../../scripts/ensure-plugin-build-deps.mjs")throw new Error("SDK build-deps contract changed");noEvents(sdk.manifest,"ensure-build-deps");pins.push(sdk.manifestPin);}
    const entry=source(step.relative);return {cwd,args:[entry.file,...step.args],pins:[...pins,entry]};
  }));}
  let selected=all;if(filters.length){
    const seeds=filters.map(filter=>filter.slice(3));if(seeds.some(seed=>!byName.has(seed)))throw new Error("Requested filter seed is not a declared workspace");
    selected=await queryMembers(filters,options);
    const selectedNames=new Set(selected.map(member=>member.name));if(seeds.some(seed=>!selectedNames.has(seed)))throw new Error("Filtered pnpm LIST omitted a requested seed");for(const member of selected){const qualified=byName.get(member.name);if(!qualified||qualified.directory!==member.directory||qualified.manifestPin.hash!==member.manifestPin.hash)throw new Error("Filtered membership differs from qualified workspace");}}
  unchanged(declared.configuration);for(const member of declared.members)unchanged(member.manifestPin);
  const order=dependencyOrder(selected);
  for(const steps of prepared.values())for(const step of steps)for(const binding of step.pins)unchanged(binding);
  for(const member of order){console.log("[workspace-gate] typecheck "+member.name);for(const step of prepared.get(member.name)){const status=await runPreparedStep(step,options);if(status!==0)return status;}}
  return 0;
}
export function runTokens({env=process.env,repoRoot=root}={}){
  const git=resolveNativeExecutable("git",{env});
  const clean=sanitizeGitLocalEnvironment(env,resolveGitLocalEnvironmentVariableNames({cwd:repoRoot,env,gitExecutable:git}));
  const capture=(args,cwd,maxBuffer=128*1024)=>{
    const result=spawnSync(git,args,{cwd,env:clean,encoding:"utf8",windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"],timeout:120000,maxBuffer,killSignal:"SIGKILL"});
    if(result.error||result.status!==0&&result.status!==1){if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);}
    return result;
  };
  const discovery=capture(["rev-parse","--show-toplevel"],repoRoot);if(discovery.error||discovery.status!==0||normalize(realpathSync(discovery.stdout.trim()))!==normalize(realpathSync(repoRoot)))throw new Error("Ordinary token work-tree discovery failed");
  const common=capture(["rev-parse","--git-common-dir"],repoRoot);if(common.error||common.status!==0||!common.stdout.trim()||/[\r\n]/u.test(common.stdout.trim()))throw new Error("Token common Git directory discovery failed");
  const logDirectory=path.resolve(repoRoot,common.stdout.trim(),"paperclip-gate-logs/direct-tokens");mkdirSync(logDirectory,{recursive:true});
  const logPrefix=path.join(logDirectory,Date.now()+"-"+process.pid);
  const persist=result=>{appendFileSync(logPrefix+".stdout.log",result.stdout??"");appendFileSync(logPrefix+".stderr.log",result.stderr??"");};persist(discovery);persist(common);
  const resolved=core.resolveRepoPaths(command=>{
    if(command==="git rev-parse --show-toplevel")return discovery.stdout;
    if(command==="git rev-parse --git-common-dir")return common.stdout;
    throw new Error("Unknown token discovery command");
  });
  const tokens=core.resolveForbiddenTokens(resolved.tokensFiles,clean);
  return core.runForbiddenTokenCheck({repoRoot:repoRoot,tokens,grep:({token,repoRoot})=>core.gitGrepToken({token,repoRoot,exec:(command,args,opts)=>{
    if(command!=="git")throw new Error("Unknown token executable");
    const result=capture(args,opts.cwd,64*1024*1024);persist(result);
    if(result.error||result.status!==0){const error=result.error??new Error("Git grep natural nonzero");error.status=result.error?null:result.status;error.stdout=result.stdout;throw error;}
    return result.stdout;
  }})});
}
export async function main(argv=process.argv.slice(2),options={}){
  const [task,...args]=argv,manifestPin=source("package.json"),manifest=JSON.parse(readFileSync(manifestPin.file,"utf8"));rootContract(manifest);unchanged(manifestPin);
  if(task==="typecheck"){
    const filters=[];for(let i=0;i<args.length;i+=2){if(args[i]!=="--filter"||!/^\.\.\.(?:@[\w.-]+\/)?[\w.-]+$/u.test(args[i+1]??""))throw new Error("Unsupported literal typecheck selector");filters.push(args[i+1]);}
    return await executeWorkspaceTypechecks(filters,options);
  }
  if(args.length)throw new Error("Root gate task takes no extra arguments");
  if(task==="tokens")return runTokens(options);
  if(task!=="preflight"&&task!=="test-run")throw new Error("Unknown direct gate task");
  const compiler=qualifyCompiler(root),pins=[manifestPin,compiler.manifest,compiler.bin,compiler.api,compiler.shim,compiler.body];
  const preflight=tsStep("scripts/ensure-workspace-package-links.ts",root,pins);
  const runner=source("scripts/run-vitest-stable.mjs");
  const status=await runPreparedStep(preflight,options);if(status!==0||task==="preflight")return status;
  return await runPreparedStep({cwd:root,args:[runner.file],pins:[...pins,runner]},options);
}
if(isMainModule(import.meta.url)){try{process.exitCode=await main();}catch(error){console.error("Direct workspace gate failed: "+error.message);process.exitCode=2;}}

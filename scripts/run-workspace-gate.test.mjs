import assert from "node:assert/strict";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {dependencyOrder,discoverDeclaredWorkspaces,executeWorkspaceTypechecks,main,planTypecheck,qualifyCompiler,runPreparedStep,runTokens} from "./run-workspace-gate.mjs";
import {resolveNativeExecutable,runGateChild} from "./gate-child.mjs";
import {resolvePnpmCli} from "./resolve-pnpm-cli.mjs";
import {resolveGitLocalEnvironmentVariableNames,sanitizeGitLocalEnvironment} from "./git-local-env.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
function member(name,typecheck,extra={}){return {name,relativePath:name,manifest:{name,scripts:{typecheck,...extra}}};}

test("current31 workspace scripts retain33 compilers,9 JS prerequisites,2 TS migration checks",()=>{
  const paths=["server","ui","cli"];
  for(const base of ["packages","packages/adapters","packages/plugins","packages/plugins/examples"]){for(const entry of (awaitDirectories(path.join(root,base)))){const relative=base+"/"+entry;if(relative==="packages/plugins/sandbox-providers"||relative==="packages/plugins/examples/plugin-orchestration-smoke-example")continue;try{readFileSync(path.join(root,relative,"package.json"));paths.push(relative);}catch{/* non-package directory */}}}
  const members=paths.map(relative=>({relativePath:relative,manifest:JSON.parse(readFileSync(path.join(root,relative,"package.json"),"utf8"))})).map(m=>({...m,name:m.manifest.name}));
  assert.equal(members.length,31);const planned=members.flatMap(planTypecheck);
  assert.equal(planned.length,44);assert.equal(planned.filter(s=>s.kind==="compiler"||s.kind==="shared-build").length,33);assert.equal(planned.filter(s=>s.kind==="source").length,9);assert.equal(planned.filter(s=>s.kind==="typescript").length,2);
  const ui=members.find(m=>m.name==="@paperclipai/ui");assert.deepEqual(planTypecheck(ui).at(-1).args,["-b"]);
  const wiki=members.find(m=>m.name==="@paperclipai/plugin-workspace-diff");assert.deepEqual(planTypecheck(wiki).at(-1).args,["--noEmit","-p","tsconfig.test.json"]);
  const order=dependencyOrder(members);assert.equal(order.length,31);assert.ok(order.findIndex(m=>m.name==="@paperclipai/shared")<order.findIndex(m=>m.name==="@paperclipai/plugin-sdk"));
});
import {readdirSync} from "node:fs";
function awaitDirectories(directory){return readdirSync(directory,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}

test("unknown scripts and lifecycle event drift reject rather than skip checks",()=>{
  assert.throws(()=>planTypecheck(member("unknown","echo skipped")),/Unsupported typecheck/);
  assert.throws(()=>planTypecheck(member("plain","tsc --noEmit",{pretypecheck:"echo hidden"})),/lifecycle event/);
  assert.throws(()=>planTypecheck(member("@paperclipai/db","pnpm run check:migrations && tsc --noEmit",{"check:migrations":"echo skipped"})),/Migration gate script changed/);
  assert.throws(()=>dependencyOrder([{name:"a",manifest:{dependencies:{b:"workspace:*"}}},{name:"b",manifest:{dependencies:{a:"workspace:*"}}}]),/cycle/);
  assert.throws(()=>dependencyOrder([{name:"same",manifest:{}},{name:"same",manifest:{}}]),/Duplicate/);
});

test("invalid task/selectors refuse before a task launch",async()=>{
  let births=0;const options={run:async()=>{births++;throw new Error("unexpected birth");}};
  await assert.rejects(main(["unknown"],options),/Unknown direct gate task/);
  await assert.rejects(main(["typecheck","--filter","other;command"],options),/selector/);
  await assert.rejects(main(["preflight","unexpected"],options),/no extra arguments/);assert.equal(births,0);
});

test("actual compiler qualification binds bin and API, wrongversion refuses",()=>{
  const binding=qualifyCompiler(root);assert.match(binding.bin.file.replaceAll("\\","/"),/\/bin\/tsc$/);assert.match(binding.api.file.replaceAll("\\","/"),/\/lib\/typescript\.js$/);assert.equal(binding.api.hash.length,64);assert.match(binding.shim.file.replaceAll("\\","/"),/\/lib\/tsc\.js$/);assert.match(binding.body.file.replaceAll("\\","/"),/\/lib\/_tsc\.js$/);assert.equal(binding.body.hash.length,64);
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-gate-compiler-"));try{mkdirSync(path.join(temporary,"node_modules/typescript"),{recursive:true});writeFileSync(path.join(temporary,"package.json"),"{}");writeFileSync(path.join(temporary,"node_modules/typescript/package.json"),JSON.stringify({name:"typescript",version:"5.8.0",bin:{tsc:"./bin/tsc"}}));assert.throws(()=>qualifyCompiler(temporary),/qualified TypeScript/);}finally{rmSync(temporary,{recursive:true,force:true});}
});

test("real token core preserves private common-dir and literal scans, fails then restores",()=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-gate-token-"));let completed=false;
  try{
    const env=sanitizeGitLocalEnvironment(process.env,resolveGitLocalEnvironmentVariableNames({cwd:root})),git=resolveNativeExecutable("git",{env});
    const invoke=args=>{const r=spawnSync(git,args,{cwd:temporary,env,encoding:"utf8",timeout:10000,maxBuffer:128*1024,windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});console.error(JSON.stringify({diagnostic:"token-fixture-git",status:r.status,stdout:r.stdout,stderr:r.stderr}));assert.equal(r.status,0,r.stderr);return r;};
    invoke(["init","--",temporary]);mkdirSync(path.join(temporary,"scripts"));writeFileSync(path.join(temporary,"scripts/forbidden-tokens.txt"),"gate.literal\\token\n");writeFileSync(path.join(temporary,"content.txt"),"neutral fixture\n");invoke(["add","--","scripts/forbidden-tokens.txt","content.txt"]);
    writeFileSync(path.join(temporary,".git/hooks/forbidden-tokens.txt"),"private-common-token\n");
    assert.equal(runTokens({env,repoRoot:temporary}),0);
    writeFileSync(path.join(temporary,"content.txt"),"gate.literal\\token\n");assert.equal(runTokens({env,repoRoot:temporary}),1);
    writeFileSync(path.join(temporary,"content.txt"),"private-common-token\n");assert.equal(runTokens({env,repoRoot:temporary}),1);
    writeFileSync(path.join(temporary,"content.txt"),"neutral fixture\n");assert.equal(runTokens({env,repoRoot:temporary}),0);completed=true;
  }finally{if(completed)rmSync(temporary,{recursive:true,force:true});else console.error(JSON.stringify({diagnostic:"failed token fixture preserved",temporary}));}
});

test("ordinary token Git discovery failure is a hard error",()=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-gate-no-git-"));try{assert.throws(()=>runTokens({repoRoot:temporary}),/Ordinary token work-tree discovery failed/);}finally{rmSync(temporary,{recursive:true,force:true});}
});


test("real query transport rejects root-only, malformed, unknown and filtered-empty LIST before any check child",async()=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-gate-list-refusal-"));let completed=false;
  try{
    const pkg=path.join(temporary,"node_modules/pnpm");mkdirSync(path.join(pkg,"bin"),{recursive:true});
    writeFileSync(path.join(temporary,"package.json"),JSON.stringify({name:"fixture-project",packageManager:"pnpm@9.15.4"}));
    writeFileSync(path.join(pkg,"package.json"),JSON.stringify({name:"pnpm",version:"9.15.4",bin:{pnpm:"bin/pnpm.cjs"}}));
    const cli=path.join(pkg,"bin/pnpm.cjs");writeFileSync(cli,'process.stdout.write(process.argv.includes("--filter")?process.env.FILTERED_LIST_JSON:process.env.FULL_LIST_JSON);\n');
    const bindingResolver=()=>resolvePnpmCli({repoRoot:temporary,env:{PATH:"",npm_execpath:""}});
    const project=JSON.parse(readFileSync(path.join(root,"package.json"),"utf8"));
    const sharedPath=path.join(root,"packages/shared"),shared=JSON.parse(readFileSync(path.join(sharedPath,"package.json"),"utf8"));
    const rootRecord={name:project.name,path:root},sharedRecord={name:shared.name,path:sharedPath};
    const complete=discoverDeclaredWorkspaces().members.map(member=>({name:member.name,path:member.directory}));
    const cases=[
      {label:"root-only",full:[rootRecord],filters:[],expected:/no qualified workspace/},
      {label:"missing-path",full:[{}],filters:[],expected:/Invalid authoritative/},
      {label:"wrong-name",full:[{name:"unknown-workspace",path:sharedPath}],filters:[],expected:/does not match manifest/},
      {label:"duplicate-directory",full:[sharedRecord,sharedRecord],filters:[],expected:/Duplicate authoritative workspace directory/},
      {label:"valid-but-partial-full",full:[sharedRecord],filters:[],expected:/not complete/},
      {label:"filtered-empty",full:complete,filtered:[rootRecord],filters:["..."+shared.name],expected:/no qualified workspace/},
      {label:"filtered-missing-seed",full:complete,filtered:complete.filter(item=>item.name!==shared.name),filters:["..."+shared.name],expected:/omitted a requested seed/},
    ];
    for(const entry of cases){let queryBirths=0,checkBirths=0;const options={bindingResolver,env:{...process.env,FULL_LIST_JSON:JSON.stringify(entry.full),FILTERED_LIST_JSON:JSON.stringify(entry.filtered??[])},run:async(executable,args,settings)=>{
      if(args[0]!==cli){checkBirths++;throw new Error("unexpected compiler/main child");}
      queryBirths++;return await runGateChild(executable,args,settings);
    }};
      await assert.rejects(executeWorkspaceTypechecks(entry.filters,options),entry.expected);
      const receipt={label:entry.label,actualQueryChildren:queryBirths,compilerOrMainLaunchRequests:checkBirths};console.error(JSON.stringify(receipt));writeFileSync(path.join(temporary,entry.label+".private.json"),JSON.stringify(receipt));
      assert.equal(checkBirths,0);assert.equal(queryBirths,entry.filters.length?2:1);
    }
    let positiveRequests=0,positiveQueries=0;
    const status=await executeWorkspaceTypechecks([],{
      bindingResolver,env:{...process.env,FULL_LIST_JSON:JSON.stringify(complete),FILTERED_LIST_JSON:"[]"},
      run:async(executable,args,settings)=>{if(args[0]===cli){positiveQueries++;return await runGateChild(executable,args,settings);}positiveRequests++;return {status:0,error:null};},
    });
    assert.equal(status,0);assert.equal(positiveQueries,1);assert.equal(positiveRequests,44,"Complete catalog retains every planned action; task results here are simulated");
    console.error(JSON.stringify({diagnostic:"complete membership realquery/simulated task results",positiveQueries,positiveRequests}));
    completed=true;
  }finally{if(completed)rmSync(temporary,{recursive:true,force:true});else console.error(JSON.stringify({diagnostic:"failed real membership-refusal fixture preserved",temporary}));}
});


test("owned compiler-body late drift refuses before birth and exact restore runs the owned chain",async()=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-gate-body-drift-"));let completed=false;
  try{
    const pkg=path.join(temporary,"node_modules/typescript");mkdirSync(path.join(pkg,"bin"),{recursive:true});mkdirSync(path.join(pkg,"lib"));
    writeFileSync(path.join(temporary,"package.json"),"{}");writeFileSync(path.join(pkg,"package.json"),JSON.stringify({name:"typescript",version:"5.9.3",bin:{tsc:"./bin/tsc"}}));
    writeFileSync(path.join(pkg,"bin/tsc"),'require("../lib/tsc.js");\n');writeFileSync(path.join(pkg,"lib/tsc.js"),'require("./_tsc.js");\n');
    writeFileSync(path.join(pkg,"lib/typescript.js"),'module.exports={version:"5.9.3"};\n');
    const bodyPath=path.join(pkg,"lib/_tsc.js"),original='process.stdout.write("owned-compiler-chain-ran\\n");\n';writeFileSync(bodyPath,original);
    const binding=qualifyCompiler(temporary),pins=[binding.manifest,binding.bin,binding.api,binding.shim,binding.body];
    let births=0;const options={run:async(executable,args,settings)=>{births++;return await runGateChild(executable,args,{...settings,timeoutMs:10000});}};
    const step={cwd:temporary,args:[binding.bin.file],pins};writeFileSync(bodyPath,'process.exitCode=0; // dishonest late no-op body\n');
    await assert.rejects(runPreparedStep(step,options),/changed before task launch/);assert.equal(births,0);
    writeFileSync(bodyPath,original);assert.equal(await runPreparedStep(step,options),0);assert.equal(births,1);
    console.error(JSON.stringify({diagnostic:"owned fake compiler-chain discriminator only",lateDriftLaunches:0,restoredActualChild:1}));completed=true;
  }finally{if(completed)rmSync(temporary,{recursive:true,force:true});else console.error(JSON.stringify({diagnostic:"failed compiler-chain fixture preserved",temporary}));}
});


test("declared catalog follows bounded real workspace globs/exclusions and refuses missing or unsupported declarations",()=>{
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-declared-catalog-"));try{
    writeFileSync(path.join(temporary,"pnpm-workspace.yaml"),'packages:\n  - packages/*\n  - "!packages/ignored/**"\n  - server\n');
    for(const [relative,name]of [["packages/a","a"],["packages/ignored","ignored"],["server","server"]]){mkdirSync(path.join(temporary,relative),{recursive:true});writeFileSync(path.join(temporary,relative,"package.json"),JSON.stringify({name,scripts:{typecheck:"tsc --noEmit"}}));}
    assert.deepEqual(discoverDeclaredWorkspaces(temporary).members.map(m=>m.name),["a","server"]);
    mkdirSync(path.join(temporary,"packages/new"));writeFileSync(path.join(temporary,"packages/new/package.json"),JSON.stringify({name:"new",scripts:{typecheck:"tsc --noEmit"}}));assert.equal(discoverDeclaredWorkspaces(temporary).members.length,3,"new declared manifest must join the required inventory");
    rmSync(path.join(temporary,"server/package.json"));assert.throws(()=>discoverDeclaredWorkspaces(temporary),/manifest is missing/);
    writeFileSync(path.join(temporary,"pnpm-workspace.yaml"),'packages:\n  - packages/**\n');assert.throws(()=>discoverDeclaredWorkspaces(temporary),/Unsupported workspace glob/);
  }finally{rmSync(temporary,{recursive:true,force:true});}
});

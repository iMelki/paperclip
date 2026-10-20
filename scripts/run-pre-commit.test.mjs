import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPreCommit } from "./run-pre-commit.mjs";
import { resolveNativeExecutable } from "./gate-child.mjs";
import { resolveGitLocalEnvironmentVariableNames, sanitizeGitLocalEnvironment } from "./git-local-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pwsh;
try { pwsh = resolveNativeExecutable("pwsh"); } catch { /* explicit platform prerequisite */ }
const git = resolveNativeExecutable("git");
const nativeOptions = { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] };

function fixture(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-pre-commit-"));
  let completed = false;
  try { const value = body(root); completed = true; return value; }
  finally {
    if (completed) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ diagnostic: "failed pre-commit fixture preserved", root }));
  }
}

test("broker preserves check failure, optional doctor status 2 and other doctor failures", async () => {
  for (const [statuses, expected, count] of [[[17],17,1],[[0,2],0,2],[[0,23],23,2],[[0,0],0,2]]) {
    const calls = [];
    const status = await runPreCommit(pwsh ?? process.execPath, { resolveExecutable: value => value, run: async (executable,args,options) => {
      calls.push({executable,args,options}); return {status: statuses[calls.length-1], error:null};
    }});
    assert.equal(status, expected); assert.equal(calls.length, count);
    assert.deepEqual(calls[0].args.slice(0,4), ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass"]);
    assert.equal(calls[0].options.input, undefined, "transport default must close stdin");
    if(count === 2) assert.equal(calls[1].executable, process.execPath);
  }
  await assert.rejects(runPreCommit(process.execPath, {resolveExecutable:value=>value,run:async()=>({status:0,error:new Error("transport failed")})}), /transport failed/);
});

test("real PowerShell broker closes stdin and awaits captured streams before doctor", {skip:!pwsh}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-commit-broker-"));
  let completed = false;
  try {
    mkdirSync(path.join(root,"scripts"));
    writeFileSync(path.join(root,"scripts/pre-commit-check.ps1"), [
      "$ErrorActionPreference = 'Stop'",
      "if (-not ([Environment]::GetCommandLineArgs() -contains '-NonInteractive')) { throw 'Missing NonInteractive' }",
      "if ([Console]::In.ReadToEnd() -ne '') { throw 'Stdin was inherited' }",
      "[Console]::Out.WriteLine('checked-stdout')",
      "[Console]::Error.WriteLine('checked-stderr')",
      "exit 0",
    ].join("\n"));
    writeFileSync(path.join(root,"scripts/run-react-doctor.js"), "process.stdout.write('doctor-after-check\\n'); process.exitCode=2;\n");
    const { Writable } = await import("node:stream");
    let stdout="",stderr="";
    const output=new Writable({write(chunk,encoding,done){stdout+=chunk;done();}});
    const errorOutput=new Writable({write(chunk,encoding,done){stderr+=chunk;done();}});
    const status=await runPreCommit(pwsh,{repoRoot:root,output,errorOutput});
    writeFileSync(path.join(root,"result.private.json"),JSON.stringify({status,stdout,stderr}));
    console.error(JSON.stringify({diagnostic:"real broker before assertions",status,stdout,stderr}));
    assert.equal(status,0); assert.match(stdout,/checked-stdout[\s\S]*doctor-after-check/); assert.match(stderr,/checked-stderr/);
    completed=true;
  } finally {
    if(completed)rmSync(root,{recursive:true,force:true});else console.error(JSON.stringify({diagnostic:"failed real broker fixture preserved",root}));
  }
});

test("real PowerShell checker preserves staged/filter/full/related gates and fails then restores", {skip:!pwsh}, () => fixture(root => {
  const scripts=path.join(root,"scripts");mkdirSync(scripts);
  for(const name of ["pre-commit-check.ps1","gate-native.ps1","affected-workspace-packages.mjs","gate-child.mjs","resolve-pnpm-cli.mjs","is-main-module.mjs"])copyFileSync(path.join(repoRoot,"scripts",name),path.join(scripts,name));
  const pkg=path.join(root,"node_modules/pnpm");mkdirSync(path.join(pkg,"bin"),{recursive:true});
  writeFileSync(path.join(root,"package.json"),JSON.stringify({packageManager:"pnpm@9.15.4"}));
  writeFileSync(path.join(pkg,"package.json"),JSON.stringify({name:"pnpm",version:"9.15.4",bin:{pnpm:"bin/pnpm.cjs"}}));
  writeFileSync(path.join(pkg,"bin/pnpm.cjs"),[
    'const fs=require("node:fs"), path=require("node:path");',
    'const args=process.argv.slice(2); fs.appendFileSync(process.env.COMMIT_CALL_LOG,JSON.stringify(args)+"\\n");',
    'if(args[0]==="list") console.log(JSON.stringify([{name:"@fixture/server",path:path.join(process.cwd(),"server")}]));',
    'else { console.error("task-stderr"); if(args.includes("typecheck"))process.exitCode=Number(process.env.COMMIT_TYPE_EXIT||0); }',
  ].join("\n"));
  for(const name of ["run-vitest-stable.mjs","verify-gitleaks.mjs"])writeFileSync(path.join(scripts,name),[
    'import {appendFileSync} from "node:fs";',
    'appendFileSync(process.env.COMMIT_CALL_LOG,JSON.stringify(process.argv.slice(1))+"\\n");',
    'process.exitCode=Number(process.env.COMMIT_SCAN_EXIT||0);',
  ].join("\n"));
  writeFileSync(path.join(scripts,"run-workspace-gate.mjs"),[
    'import {appendFileSync} from "node:fs";',
    'const args=process.argv.slice(2);appendFileSync(process.env.COMMIT_CALL_LOG,JSON.stringify(args)+"\\n");',
    'process.exitCode=args[0]==="typecheck"?Number(process.env.COMMIT_TYPE_EXIT||0):0;',
  ].join("\n"));
  const env=sanitizeGitLocalEnvironment(process.env,resolveGitLocalEnvironmentVariableNames({cwd:repoRoot}));
  const g=(args)=>{const result=spawnSync(git,args,{...nativeOptions,cwd:root,env});assert.equal(result.status,0,result.stderr);return result;};
  g(["init","--",root]);
  const actualRoot=g(["rev-parse","--show-toplevel"]).stdout.trim();
  assert.equal(path.resolve(actualRoot).toLowerCase(),path.resolve(root).toLowerCase(),"fixture must own its real Git root");
  mkdirSync(path.join(root,"server/src"),{recursive:true});writeFileSync(path.join(root,"server/src/a.ts"),"export const a=1;\n");
  g(["add","--","server/src/a.ts"]);
  const log=path.join(root,"calls.log");
  const invoke=(extra={},all=false)=>{
    writeFileSync(log,"");const result=spawnSync(pwsh,["-NoProfile","-NonInteractive","-File",path.join(scripts,"pre-commit-check.ps1"),...(all?["-All"]:[])],{...nativeOptions,cwd:root,env:{...env,COMMIT_CALL_LOG:log,...extra}});
    writeFileSync(path.join(root,"result.private.json"),JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr}));
    console.error(JSON.stringify({diagnostic:"pre-commit child before assertions",status:result.status,stdout:result.stdout,stderr:result.stderr}));
    return {result,calls:readFileSync(log,"utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse)};
  };
  const failed=invoke({COMMIT_TYPE_EXIT:"17"});assert.equal(failed.result.status,1);assert.match(failed.result.stdout,/TypeScript check failed/);
  const restored=invoke();assert.equal(restored.result.status,0,restored.result.stderr);
  assert.ok(restored.calls.some(args=>JSON.stringify(args)===JSON.stringify(["typecheck","--filter","...@fixture/server"])));
  assert.ok(restored.calls.some(args=>args.includes("preflight")));
  assert.ok(restored.calls.some(args=>args.includes("--related")&&args.includes("server/src/a.ts")));
  assert.ok(restored.calls.some(args=>args.includes("tokens")));
  assert.ok(restored.calls.some(args=>args.includes("--staged")));
  const scanFailed=invoke({COMMIT_SCAN_EXIT:"23"});assert.equal(scanFailed.result.status,1);assert.match(scanFailed.result.stdout,/Pinned Gitleaks scan failed/);
  // Preserve the original lockfile-consistency rule even for an explicit full sweep.
  const fullWithoutLock=invoke({},true);assert.equal(fullWithoutLock.result.status,1);assert.match(fullWithoutLock.result.stdout,/without pnpm-lock/);
  writeFileSync(path.join(root,"pnpm-lock.yaml"),"lockfileVersion: '9.0'\n");g(["add","--","pnpm-lock.yaml"]);
  const full=invoke({},true);assert.equal(full.result.status,0,full.result.stderr);
  assert.ok(full.calls.some(args=>JSON.stringify(args)===JSON.stringify(["typecheck"])));
  assert.ok(full.calls.some(args=>JSON.stringify(args)===JSON.stringify(["test-run"])));
}));

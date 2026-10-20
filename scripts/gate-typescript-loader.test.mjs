import assert from "node:assert/strict";
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const files=["scripts/ensure-workspace-package-links.ts","packages/db/src/check-migration-numbering.ts","packages/db/src/check-migration-safety.ts","packages/db/src/migration-safety-baseline.ts","packages/db/src/table-size-estimates.ts"];
function fixture(body){
  const temporary=mkdtempSync(path.join(os.tmpdir(),"paperclip-gate-ts-"));let completed=false;
  try{
    for(const relative of [...files,"scripts/gate-typescript-loader.mjs"]){mkdirSync(path.dirname(path.join(temporary,relative)),{recursive:true});copyFileSync(path.join(root,relative),path.join(temporary,relative));}
    mkdirSync(path.join(temporary,"node_modules"));
    symlinkSync(realpathSync(path.join(root,"node_modules/typescript")),path.join(temporary,"node_modules/typescript"),process.platform==="win32"?"junction":"dir");
    const invoke=(relative,label)=>{
      const result=spawnSync(process.execPath,["--loader",path.join(temporary,"scripts/gate-typescript-loader.mjs"),path.join(temporary,relative)],{cwd:temporary,encoding:"utf8",timeout:30000,maxBuffer:1024*1024,windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});
      const receipt={status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr};writeFileSync(path.join(temporary,label+".private.json"),JSON.stringify(receipt));console.error(JSON.stringify({diagnostic:label,...receipt}));return result;
    };
    const value=body({temporary,invoke});completed=true;return value;
  }finally{if(completed)rmSync(temporary,{recursive:true,force:true});else console.error(JSON.stringify({diagnostic:"failed gate TS fixture preserved",temporary}));}
}
function migrations(temporary){const dir=path.join(temporary,"packages/db/src/migrations");mkdirSync(path.join(dir,"meta"),{recursive:true});writeFileSync(path.join(dir,"1000_fixture.sql"),"SELECT 1;\n");writeFileSync(path.join(dir,"meta/_journal.json"),JSON.stringify({entries:[{idx:0,tag:"1000_fixture"}]}));return dir;}

test("actual numbering CLI fails duplicate migration numbers and passes after restore",()=>fixture(({temporary,invoke})=>{
  const dir=migrations(temporary);writeFileSync(path.join(dir,"1000_duplicate.sql"),"SELECT 1;\n");
  const failed=invoke("packages/db/src/check-migration-numbering.ts","numbering-negative");assert.notEqual(failed.status,0);assert.match(failed.stderr,/Duplicate migration number/);
  rmSync(path.join(dir,"1000_duplicate.sql"));const restored=invoke("packages/db/src/check-migration-numbering.ts","numbering-restored");assert.equal(restored.status,0,restored.stderr);
}));

test("actual safety CLI main guard executes both mapped data modules and rejects unsafe SQL then restores",()=>fixture(({temporary,invoke})=>{
  const dir=migrations(temporary);writeFileSync(path.join(dir,"1000_fixture.sql"),"CREATE INDEX gate_fixture_index ON issue_comments (id);\n");
  const failed=invoke("packages/db/src/check-migration-safety.ts","safety-negative");assert.equal(failed.status,1,failed.stderr);assert.match(failed.stderr,/Migration safety check found/);assert.match(failed.stderr,/large-create-index-not-concurrently/);
  writeFileSync(path.join(dir,"1000_fixture.sql"),"SELECT 1;\n");const restored=invoke("packages/db/src/check-migration-safety.ts","safety-restored");assert.equal(restored.status,0,restored.stderr);assert.match(restored.stdout,/Migration safety check passed/);
}));

test("real preflight keeps repo root and repairs its existing workspace-link contract",()=>fixture(({temporary,invoke})=>{
  for(const dir of ["server","ui","cli","packages/shared","packages/stale"]){mkdirSync(path.join(temporary,dir),{recursive:true});writeFileSync(path.join(temporary,dir,"package.json"),JSON.stringify({name:dir==="packages/shared"?"@paperclipai/shared":dir,dependencies:dir==="server"?{"@paperclipai/shared":"workspace:*"}:{}}));}
  const link=path.join(temporary,"server/node_modules/@paperclipai/shared");mkdirSync(path.dirname(link),{recursive:true});symlinkSync(path.join(temporary,"packages/stale"),link,process.platform==="win32"?"junction":"dir");
  const result=invoke("scripts/ensure-workspace-package-links.ts","preflight-real");assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/relinking dependencies/);assert.equal(realpathSync(link),realpathSync(path.join(temporary,"packages/shared")));
}));

test("loader refuses unknown TS, TSX and malformed qualified source",()=>fixture(({temporary,invoke})=>{
  for(const extension of ["ts","tsx"]){const file="scripts/not-qualified."+extension;writeFileSync(path.join(temporary,file),"console.log('must not execute');\n");const rejected=invoke(file,"refuse-"+extension);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/unqualified TypeScript/);assert.doesNotMatch(rejected.stdout,/must not execute/);}
  writeFileSync(path.join(temporary,"packages/db/src/check-migration-numbering.ts"),"const invalid: = ;\n");const broken=invoke("packages/db/src/check-migration-numbering.ts","malformed-qualified");assert.notEqual(broken.status,0);assert.match(broken.stderr,/transpilation failed/);
}));

test("data module mappings are scoped to safety parent, not a generic .js resolver",()=>fixture(({temporary,invoke})=>{
  writeFileSync(path.join(temporary,"packages/db/src/check-migration-numbering.ts"),'import {MIGRATION_SAFETY_BASELINE} from "./migration-safety-baseline.js"; console.log(MIGRATION_SAFETY_BASELINE);\n');
  const rejected=invoke("packages/db/src/check-migration-numbering.ts","wrong-parent-map");assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/ERR_MODULE_NOT_FOUND|Cannot find module/);
}));

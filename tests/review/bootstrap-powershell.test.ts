import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

test('masked bootstrap transports identity and Unicode password under Windows PowerShell 5', {skip:process.platform!=='win32'},async()=>{
  await mkdir('work',{recursive:true});
  const root=await mkdtemp(path.resolve('work/bootstrap-compat-'));
  try{
    await mkdir(path.join(root,'scripts'),{recursive:true});
    await mkdir(path.join(root,'apps/api/src/auth'),{recursive:true});
    await copyFile('scripts/bootstrap.ps1',path.join(root,'scripts/bootstrap.ps1'));
    await writeFile(path.join(root,'apps/api/src/auth/bootstrap.ts'),`import assert from 'node:assert/strict';
async function main(){let input='';for await(const chunk of process.stdin)input+=chunk.toString('utf8');
assert.equal(process.env.SHI_BOOTSTRAP_EMAIL,'operator@example.test');
assert.equal(process.env.SHI_BOOTSTRAP_DISPLAY_NAME,${JSON.stringify('Operator "Quoted" \\ Name')});
assert.equal(input.trimEnd(),'long Unicode password \\u00e9');
assert.equal(process.argv.some(value=>value.includes('password')),false);
console.log('Bootstrap transport verified');}main().catch(()=>{console.error('Transport assertion failed');process.exitCode=1;});`);
    const script=`$ErrorActionPreference='Stop'; function Read-Host { param([string]$Prompt,[switch]$AsSecureString) if($AsSecureString){return ConvertTo-SecureString 'long Unicode password é' -AsPlainText -Force} if($Prompt -like '*email*'){return 'operator@example.test'} return 'Operator "Quoted" \\ Name' }; & '${path.join(root,'scripts/bootstrap.ps1').replaceAll("'","''")}'`;
    const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:20000,env:{...process.env,PSModulePath:process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
    assert.match(result.stdout,/Bootstrap transport verified/);
  }finally{await rm(root,{recursive:true,force:true});}
});

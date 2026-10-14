import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const paired=path.resolve(process.env.E2_PROJECT_ROOT||path.join(root,'../E2local-main'));
if(JSON.parse(await readFile(path.join(paired,'package.json'),'utf8')).name!=='e2-local')throw new Error('E2_PROJECT_ROOT must identify the paired e2-local repository');
async function digest(file) {
  return createHash('sha256').update((await readFile(file,'utf8')).replaceAll('\r\n','\n')).digest('hex');
}
async function inventory(directory) {
  const migrations=path.join(directory,'supabase/migrations');
  const result={};
  for(const name of (await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort())result[name]=await digest(path.join(migrations,name));
  return result;
}
const sources=[
  'app/api/web-hosting/route.ts','app/api/web-hosting/[siteId]/route.ts',
  'app/api/web-hosting/[siteId]/deployments/route.ts',
  'app/api/web-hosting/[siteId]/deployments/[deploymentId]/route.ts',
  'lib/hosting/read-model.ts','lib/hosting/r2.ts','lib/hosting/operation.ts','lib/hosting/publication.ts',
  'lib/hosting/build.ts','lib/hosting/delete.ts','lib/hosting/db.ts',
  'lib/hosting/assets.ts','lib/hosting/constants.ts','lib/request-body.ts',
  'lib/supabase/admin.ts','workers/e2-sites/src/index.ts','package.json','package-lock.json',
];
const sourceHashes={};for(const file of sources)sourceHashes[file]=await digest(path.join(paired,file));
const actual={purpose:'Offline paired fixture and hosting contract; not a production replay plan',
  repositories:{crm:'kittoe99/sms-automation',e2:'kittoe99/E2local'},
  fixtureOrder:['crm','e2'],crm:await inventory(root),e2:await inventory(paired),e2HostingSources:sourceHashes};
const manifest=path.join(root,'config/paired-baseline.json');
if(process.argv.includes('--record')) {
  await writeFile(manifest,JSON.stringify(actual,null,2)+'\n');
  console.log('Recorded local paired migration and hosting baseline. No database was contacted.');
} else {
  const expected=JSON.parse(await readFile(manifest,'utf8'));
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('Paired baseline differs. Review owning migrations/contracts, run paired tests, then explicitly record the new baseline. Never replay histories on a shared database.');
  console.log('Paired source/migration fingerprints match.');
  if(process.argv.includes('--test')) {
    const files=['hosting-tabs','hosting-storage','hosting-lifecycle','hosting-operation-database','site-details','platform-hosting-auth','platform-login-realms','business-services-database','customer-voice'];
    const available=await readdir(path.join(paired,'tests'));
    const required=files.map(name=>`tests/${name}.test.mjs`);
    for(const file of required)if(!available.includes(path.basename(file)))throw new Error(`Missing paired contract test: ${file}`);
    const result=spawnSync(process.execPath,['--test',...required],{cwd:paired,stdio:'inherit',env:{...process.env,SMS_PROJECT_ROOT:root}});
    if(result.error)throw result.error;
    process.exitCode=result.status??1;
  }
}

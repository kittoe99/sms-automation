import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {toolManifest} from '../src/mcp/manifest.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';
test('MCP manifest matches deployed gateway grant mapping and has schemas/tests for every tool',async()=>{
 const files=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort();let gateway='';
 for(const f of files){const text=await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8');if(text.includes('create or replace function sms_private.mcp_invoke'))gateway=text;}
 const block=gateway.slice(gateway.indexOf('required_permission:=case tool'),gateway.indexOf('if required_permission is null'));
 const permissions=Object.fromEntries([...block.matchAll(/when '(crm_[^']+)' then '([^']+)'/g)].map(m=>[m[1],m[2]]));
 assert.equal(new Set(toolManifest.map(t=>t.name)).size,toolManifest.length);
 for(const tool of toolManifest){assert.ok(tool.input);assert.ok(tool.output);assert.ok(tool.canonicalOperation);if(tool.name==='crm_get_access')assert.equal(tool.permission,null);else{assert.ok(connectionPermissionNames.includes(tool.permission));assert.equal(tool.permission,permissions[tool.name],tool.name);}for(const p of tool.tests)await access(new URL('../'+p,import.meta.url));}
});

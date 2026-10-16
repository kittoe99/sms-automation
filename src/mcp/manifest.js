import {z} from 'zod';
import {toolDefinitions,toolOutputs} from './tools.js';
import {toolPermissions,externalTools} from './toolPolicy.js';
import {contactToolPermissions} from './contactSchemas.js';
// Runtime schemas are reused, never copied into a second hand-maintained catalog.
export const toolManifest=toolDefinitions.map(([name,description,input,writing=false])=>({
 name,description,input:z.object(input).strict(),output:toolOutputs[name],
 permission:toolPermissions[name]??null,
 canonicalOperation:name in contactToolPermissions?'sms_private.mcp_contact_action':'sms_private.mcp_invoke',
 revisionInputs:Object.keys(input).filter(k=>/revision|generation/i.test(k)),
 effects:writing?(externalTools.has(name)?'database_and_provider_work':'database_or_scheduled_work'):'read_or_preview',
 tests:['test/mcpServer.test.js',...(name in contactToolPermissions?['test/mcpContacts.test.js']:[])],
}));

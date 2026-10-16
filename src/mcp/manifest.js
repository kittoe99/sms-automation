import {operationsToolPermissions} from './operationsSchemas.js';
import {websiteToolPermissions} from './websiteSchemas.js';
import {voiceToolPermissions} from './voiceSchemas.js';
import {emailToolPermissions} from './emailSchemas.js';
import {knowledgeToolPermissions} from './knowledgeSchemas.js';
import {bookingToolPermissions} from './bookingSchemas.js';
import {formLifecycleToolPermissions} from './formLifecycleSchemas.js';
import {z} from 'zod';
import {toolDefinitions,toolOutputs} from './tools.js';
import {toolPermissions,externalTools} from './toolPolicy.js';
import {contactToolPermissions} from './contactSchemas.js';
import {activityToolPermissions} from './activitySchemas.js';
// Runtime schemas are reused, never copied into a second hand-maintained catalog.
export const toolManifest=toolDefinitions.map(([name,description,input,writing=false])=>({
 name,description,input:z.object(input).strict(),output:toolOutputs[name],
 permission:toolPermissions[name]??null,
 canonicalOperation:name in operationsToolPermissions?'sms_private.mcp_operations_action':name in websiteToolPermissions?'sms_private.mcp_website_action':name in voiceToolPermissions?'sms_private.mcp_voice_action':name in emailToolPermissions?'sms_private.mcp_email_action':name in knowledgeToolPermissions?'sms_private.mcp_knowledge_action':name in bookingToolPermissions?'sms_private.mcp_booking_action':name in formLifecycleToolPermissions?'sms_private.mcp_form_lifecycle':name in activityToolPermissions?'sms_private.mcp_activity_action':name in contactToolPermissions?'sms_private.mcp_contact_action':'sms_private.mcp_invoke',
 revisionInputs:Object.keys(input).filter(k=>/revision|generation/i.test(k)),
 effects:writing?(externalTools.has(name)?'database_and_provider_work':'database_or_scheduled_work'):'read_or_preview',
 tests:['test/mcpServer.test.js',...(name in operationsToolPermissions?['test/mcpOperations.test.js']:[]),...(name in websiteToolPermissions?['test/mcpWebsites.test.js']:[]),...(name in voiceToolPermissions?['test/mcpVoice.test.js']:[]),...(name in emailToolPermissions?['test/mcpEmail.test.js']:[]),...(name in knowledgeToolPermissions?['test/mcpKnowledge.test.js']:[]),...(name in bookingToolPermissions?['test/mcpBookings.test.js']:[]),...(name in formLifecycleToolPermissions?['test/mcpFormLifecycle.test.js']:[]),...(name in contactToolPermissions?['test/mcpContacts.test.js']:[]),...(name in activityToolPermissions?['test/mcpActivityManagement.test.js']:[])],
}));

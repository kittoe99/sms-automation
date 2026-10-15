// Shared by the administrator editor and MCP output validation. New grants are opt-in.
export const connectionPermissions = [
 ['read','Read permitted businesses and customers'],
 ['draft','Edit business drafts'],
 ['review','Approve business profiles'],
 ['service_add','Add services (SMS may start provider setup)'],
 ['visibility','Release or hide customer service access'],
 ['global_customer_lookup','Look up customers across the platform'],
 ['automation_read','Read SMS automations, contacts and submission references'],
 ['automation_draft','Create and edit SMS automation drafts'],
 ['automation_preview','Simulate SMS automations without sending'],
 ['automation_publish','Publish saved SMS automation drafts'],
 ['automation_enable','Enable form follow-ups or disable and pause their active runs'],
 ['automation_run_start','Start published SMS runs for contacts and past submissions'],
 ['automation_run_resume','Resume paused SMS runs with current consent'],
 ['automation_run_pause_stop','Pause or stop SMS runs and replace selected overlaps'],
 ['automation_activity','Inspect SMS runs and their activity'],
];
export const connectionPermissionNames=connectionPermissions.map(([key])=>key);

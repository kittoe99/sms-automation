import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {FormService,bad} from './service.js';
import {verifyFormToken} from './tokens.js';
export const TOOL_NAMES=['get_business_context','list_automation_groups','get_automation_group','list_rule_presets','get_form_draft','save_form_draft','draft_automation_group','set_form_routes','validate_form','simulate_submission'];
export async function executeFormTool(db,claims,name,args={}) {
  if(!TOOL_NAMES.includes(name)) throw bad('Tool not allowed',403);
  await db.call('forms_agent',claims.tenant,claims.user,claims.form,claims.session,'tool',{name});
  try {
    const result=await dispatchFormTool(db,claims,name,args);
    await db.call('forms_agent',claims.tenant,claims.user,claims.form,claims.session,'result',{name,ok:true,revision:result?.revision??null});
    return result;
  } catch(error) {
    await db.call('forms_agent',claims.tenant,claims.user,claims.form,claims.session,'result',{name,ok:false,code:String(error.status||error.code||'TOOL_FAILED')}).catch(()=>{});
    throw error;
  }
}
async function dispatchFormTool(db,claims,name,args) {
  const service=new FormService(db,claims.user,claims.tenant),id=claims.form;
  if(name==='get_business_context') return (await service.catalog()).business;
  if(name==='list_automation_groups') return (await service.catalog()).groups;
  if(name==='get_automation_group') {
    const g=(await service.catalog()).groups.find(g=>g.id===args.groupId);if(!g) throw bad('Automation not found',404);return g;
  }
  if(name==='list_rule_presets') {const c=await service.catalog();return {presets:c.presets,mappings:c.mappings};}
  if(name==='get_form_draft') return service.get(id);
  if(name==='save_form_draft') return service.save(id,args.revision,args.definition,args.draftGroups);
  if(name==='validate_form') return service.validate(id);
  if(name==='simulate_submission') return service.simulate(id,args.answers);
  const f=await service.get(id);
  if(name==='set_form_routes') return service.save(id,args.revision,{...f.draft,routing:args.routing});
  if(name==='draft_automation_group') {
    const group={...args.group,id:`form-${id}-${args.key}`};
    return service.save(id,args.revision,f.draft,[...f.draft_groups.filter(g=>g.id!==group.id),group]);
  }
}
export function formMcpHandler(db) {
  return async(req,res,next)=>{
    let server,transport;
    try {
      const claims=await verifyFormToken(String(req.headers.authorization||'').replace(/^Bearer /,''),'forms-mcp');
      await db.call('forms_agent',claims.tenant,claims.user,claims.form,claims.session,'authorize',{});
      if(req.headers.origin) throw bad('Browser access to MCP is not allowed',403);
      server=new McpServer({name:'sms-form-builder',version:'1.0.0'});
      const descriptions={get_business_context:'Read approved business facts.',list_automation_groups:'List this business automation groups and versions.',get_automation_group:'Inspect one automation and its message steps.',list_rule_presets:'Discover supported rule presets and field mappings.',get_form_draft:'Read the current form draft, revision, and pending automation groups.',save_form_draft:'Save a FormDefinition. Requires the latest revision; never publishes.',draft_automation_group:'Create or replace a form-owned draft automation. No live changes.',set_form_routes:'Set ordered routing rules and reviewedVersions using real catalog versions.',validate_form:'Validate all fields, mappings and automation references.',simulate_submission:'Dry-run answers against the draft. Never changes contacts or sends SMS.'};
      for(const name of TOOL_NAMES) {
        const inputSchema=name==='get_automation_group'?{groupId:z.string()}:name==='save_form_draft'?{revision:z.number().int(),definition:z.record(z.unknown()),draftGroups:z.array(z.record(z.unknown())).max(10).optional()}:
          name==='draft_automation_group'?{revision:z.number().int(),key:z.string().regex(/^[a-z0-9-]{1,32}$/),group:z.record(z.unknown())}:
          name==='set_form_routes'?{revision:z.number().int(),routing:z.record(z.unknown())}:name==='simulate_submission'?{answers:z.record(z.unknown())}:{};
        server.registerTool(name,{description:descriptions[name],inputSchema,annotations:{readOnlyHint:!['save_form_draft','draft_automation_group','set_form_routes'].includes(name),destructiveHint:false,openWorldHint:false}},async args=>{
          try{return {content:[{type:'text',text:JSON.stringify(await executeFormTool(db,claims,name,args))}]};}
          catch(error){return {isError:true,content:[{type:'text',text:error.status||error.code==='23505'||error.code==='P0001'?error.message:'Tool failed. Read the draft and retry.'}]};}
        });
      }
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{transport.close();server.close();});
      await server.connect(transport);
      await transport.handleRequest(req,res,req.body);
    } catch(error){next(error);}
  };
}

import {env} from '../_shared/http.js';
export async function executeMcpEmailAction(db,body,{openaiConfigured=Boolean(env('OPENAI_API_KEY'))}={}) {
 if(!body||Object.keys(body).sort().join(',')!=='input,ticket'||typeof body.ticket!=='string'||!/^[0-9a-f-]{72}$/.test(body.ticket)||!body.input||typeof body.input!=='object'||Array.isArray(body.input))throw Object.assign(new Error('Email action access denied'),{status:403});
 return db.call('mcp_execute_email_action',body.ticket,body.input,openaiConfigured);
}

import {voiceStorage} from '../_shared/voice-storage.js';
export async function signMcpVoiceMedia(db,input,{storage=voiceStorage()}={}) {
 if(!input||Object.keys(input).length!==1||typeof input.ticket!=='string'||!/^[0-9a-f-]{72}$/.test(input.ticket))throw Object.assign(new Error('Recording access denied'),{status:403});
 const access=await db.call('mcp_consume_voice_media_ticket',input.ticket);
 return storage.playback(access.path,access.expiresIn);
}

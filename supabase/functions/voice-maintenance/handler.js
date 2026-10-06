import {json,failure} from '../_shared/http.js';
import {voiceStorage} from '../_shared/voice-storage.js';
export function createVoiceMaintenance(db,{secret,storage=voiceStorage()}={}) {
 return async request=>{try{
  if(request.method!=='POST')return json({error:'POST required'},405);
  if(!secret||secret.length<32||request.headers.get('Authorization')!==`Bearer ${secret}`)return json({error:'Unauthorized'},401);
  const {paths}=await db.call('cleanup',{});
  await storage.remove(paths);
  if(paths.length)await db.call('cleanup',{deleted:paths});
  return json({deleted:paths.length});
 }catch(error){return failure(error);}};
}

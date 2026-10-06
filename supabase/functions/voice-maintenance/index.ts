import {env} from '../_shared/http.js';
import {runtimeDatabase} from '../voice-runtime/database.js';
import {createVoiceMaintenance} from './handler.js';
Deno.serve(createVoiceMaintenance(runtimeDatabase(env('VOICE_MAINTENANCE_DATABASE_URL'),{maintenance:true}),{secret:env('VOICE_MAINTENANCE_SECRET')}));

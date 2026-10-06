import {env} from '../_shared/http.js';
import {runtimeDatabase} from './database.js';
import {createRuntimeHandler} from './handler.js';
Deno.serve(createRuntimeHandler(runtimeDatabase(env('VOICE_RUNTIME_DATABASE_URL')),
 {secret:env('VOICE_RUNTIME_SECRET'),enabled:env('VOICE_CRM_ENABLED')==='true'}));

import {env} from '../_shared/http.js';
import {smsDatabase} from './database.js';
import {createSmsHandler} from './handler.js';
Deno.serve(createSmsHandler(smsDatabase(env('VOICE_SMS_DATABASE_URL')),
 {secret:env('SONI_SMS_SECRET'),enabled:env('VOICE_SMS_ENABLED')==='true'}));

import {env} from '../_shared/http.js';
import {lookupDatabase} from './database.js';
import {createLookupHandler} from './handler.js';
Deno.serve(createLookupHandler(lookupDatabase(env('VOICE_LOOKUP_DATABASE_URL')) ,{
  secret:env('SONI_LOOKUP_SECRET'),otpSecret:env('SONI_LOOKUP_OTP_SECRET'),
}));

import {database,env} from '../_shared/http.js';
import {createVoiceHandler} from './handler.js';
Deno.serve(createVoiceHandler(database('VOICE_AGENT_DATABASE_URL'),{
  secret:env('SONI_BRIDGE_SECRET'),otpSecret:env('SONI_OTP_SECRET'),
}));

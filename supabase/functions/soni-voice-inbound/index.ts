import {database,env} from '../_shared/http.js';
import {createSoniInboundHandler} from './handler.js';

Deno.serve(createSoniInboundHandler(database('SMS_WEBHOOK_DATABASE_URL'),{
  base:env('SONI_VOICE_WEBHOOK_URL'),
  sipUsername:env('SONI_SIP_USERNAME'),
  sipPassword:env('SONI_SIP_PASSWORD'),
}));

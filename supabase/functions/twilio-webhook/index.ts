import {database} from '../_shared/http.js';
import {createTwilioHandler} from './handler.js';
Deno.serve(createTwilioHandler(database('SMS_WEBHOOK_DATABASE_URL')));

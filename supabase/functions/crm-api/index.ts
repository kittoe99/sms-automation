import { database } from '../_shared/http.js';
import { createCrmHandler } from './handler.js';
Deno.serve(createCrmHandler(database('SMS_API_DATABASE_URL')));

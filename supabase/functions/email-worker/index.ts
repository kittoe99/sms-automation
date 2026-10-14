import { database, env } from '../_shared/http.js';
import { createEmailWorkerHandler } from './handler.js';

const db = database('SMS_AUTOMATION_DATABASE_URL');
Deno.serve(createEmailWorkerHandler({ db, secret: env('AUTOMATION_WORKER_SECRET') }));

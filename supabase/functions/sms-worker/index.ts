import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processSms} from '../../../src/workers/sms.js';
Deno.serve(createWorkerHandler({queue:'sms_send_jobs',secret:env('SMS_WORKER_SECRET'),db:database('SMS_SENDER_DATABASE_URL'),processJob:processSms,maxJobs:5,budgetMs:40000}));

import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processHandoffAlert} from '../../../src/workers/handoff.js';
Deno.serve(createWorkerHandler({queue:'handoff_alert_jobs',secret:env('HANDOFF_WORKER_SECRET'),db:database('SMS_SENDER_DATABASE_URL'),processJob:processHandoffAlert,maxJobs:3,budgetMs:40000}));

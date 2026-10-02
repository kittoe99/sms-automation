import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processProvisioning} from '../../../src/workers/provisioning.js';
Deno.serve(createWorkerHandler({queue:'provisioning_jobs',secret:env('PROVISIONING_WORKER_SECRET'),db:database('SMS_AUTOMATION_DATABASE_URL'),processJob:processProvisioning,maxJobs:1,budgetMs:40000}));

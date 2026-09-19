import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processAutomation} from '../../../src/workers/automation.js';
Deno.serve(createWorkerHandler({queue:'automation_jobs',secret:env('AUTOMATION_WORKER_SECRET'),db:database('SMS_AUTOMATION_DATABASE_URL'),processJob:processAutomation,maxJobs:25,budgetMs:35000}));

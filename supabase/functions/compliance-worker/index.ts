import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processCompliance} from '../../../src/workers/compliance.js';
Deno.serve(createWorkerHandler({queue:'compliance_jobs',secret:env('COMPLIANCE_WORKER_SECRET'),db:database('SMS_AUTOMATION_DATABASE_URL'),processJob:processCompliance,maxJobs:1,budgetMs:40000}));

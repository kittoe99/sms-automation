import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processAi} from '../../../src/workers/ai.js';
Deno.serve(createWorkerHandler({queue:'ai_reply_jobs',secret:env('AI_WORKER_SECRET'),db:database('SMS_AI_DATABASE_URL'),processJob:processAi,maxJobs:1,budgetMs:40000}));

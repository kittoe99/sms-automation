import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processKnowledge} from '../../../src/workers/knowledge.js';
Deno.serve(createWorkerHandler({queue:'knowledge_ingest_jobs',secret:env('KNOWLEDGE_WORKER_SECRET'),db:database('SMS_AI_DATABASE_URL'),processJob:processKnowledge,maxJobs:1,budgetMs:40000}));

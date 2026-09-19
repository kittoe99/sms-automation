import {database} from '../_shared/http.js';
import {createWorkerHandler,env} from '../_shared/worker.js';
import {processEmbeddings} from '../../../src/workers/embeddings.js';
Deno.serve(createWorkerHandler({queue:'embedding_jobs',secret:env('EMBEDDING_WORKER_SECRET'),db:database('SMS_AI_DATABASE_URL'),processJob:processEmbeddings,maxJobs:1,budgetMs:40000}));

import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentMarkup} from '../public/websiteDeployments.js';
const site={slug:'example',publicationStatus:'published',liveDeploymentId:'live',deployments:[
 {id:'draft',status:'ready',created_at:'2026-10-10',source_bytes:2048,preview_token:'a'.repeat(32)},
 {id:'live',status:'ready',created_at:'2026-10-09',source_bytes:1024},
 {id:'failed',status:'failed',created_at:'2026-10-08',source_bytes:100,error_message:'<script>unsafe</script>'},
 {id:'building',status:'building',created_at:'2026-10-07',source_bytes:100},
]};
test('deployment controls preserve publish eligibility, retry and deletion restrictions',()=>{
 const html=deploymentMarkup(site,x=>x);
 assert.match(html,/data-publish="draft"/);assert.doesNotMatch(html,/data-publish="live"|data-publish="failed"|data-publish="building"/);
 assert.match(html,/data-delete-version="live" disabled/);assert.match(html,/data-delete-version="building" disabled/);
 assert.match(html,/data-build="failed"/);assert.match(html,/data-files-id="live"/);
 assert.match(html,/aria-label="Preview version 4"/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('empty and unavailable states distinguish publication from upload history',()=>{
 const empty=deploymentMarkup({...site,publicationStatus:'unpublished',deployments:[]},x=>x);
 assert.match(empty,/No deployments yet/);assert.match(empty,/Not published/);assert.doesNotMatch(empty,/Visit website/);
 const unavailable=deploymentMarkup({...site,slug:'<unsafe>',publicationStatus:'unavailable'},x=>x);
 assert.match(unavailable,/Status unavailable/);assert.match(unavailable,/&lt;unsafe&gt;/);assert.doesNotMatch(unavailable,/Visit website|<unsafe>/);
});

test('deployment pagination retains portfolio version numbers and live publication status',()=>{
 const html=deploymentMarkup(site,x=>x,{page:2,pageSize:25,total:31});
 assert.match(html,/31 versions/);assert.match(html,/Version 6/);assert.match(html,/Preview version 6/);
 assert.match(html,/data-delete-version="live" disabled/);assert.match(html,/Visit website/);
});

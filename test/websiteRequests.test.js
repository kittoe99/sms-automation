import test from 'node:test';
import assert from 'node:assert/strict';
import {requestMarkup} from '../public/websiteRequests.js';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('customer request content and staff replies are escaped; status and form controls are preserved',()=>{
 const html=requestMarkup({id:'request',title:'<script>attack</script>',category:'content',page:'<img src=x>',description:'</p><script>attack</script>',status:'needs_info',response:'</textarea><img src=x>',created_at:'2026-10-08'},escape,x=>x);
 assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;script&gt;/);assert.match(html,/value="needs_info" selected/);assert.match(html,/maxlength="2000"/);assert.match(html,/Reply visible to the customer/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {domainOfferMarkup,domainResultsMarkup,siteDomainMarkup} from '../public/websiteDomains.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('search results show live pricing, availability reasons and escape provider text',()=>{
 const html=domainResultsMarkup([{name:'acme.com',registrable:true,registrationCost:'10.44',renewalCost:'10.44',currency:'USD'},{name:'<img src=x>.dev',registrable:false,reason:'domain_unavailable'}],escape);
 assert.match(html,/10\.44 USD first year/);assert.match(html,/data-view-domain="acme.com"/);assert.match(html,/Already registered/);
 assert.doesNotMatch(html,/<img/);assert.equal((html.match(/data-view-domain/g)||[]).length,1);
});
test('an offer states the exact charge and only standard registrable domains can be bought',()=>{
 const html=domainOfferMarkup({name:'acme.com',registrable:true,tier:'standard',registrationCost:'10.44',renewalCost:'10.44',currency:'USD'},escape);
 assert.match(html,/data-buy-domain="acme.com" data-cost="10.44" data-currency="USD"/);assert.match(html,/non-refundable/);
 assert.doesNotMatch(domainOfferMarkup({name:'acme.com',registrable:true,tier:'premium',registrationCost:'900.00'},escape),/data-buy-domain/);
 assert.doesNotMatch(domainOfferMarkup({name:'acme.com',registrable:false,reason:'domain_unavailable'},escape),/data-buy-domain/);
});
test('site domain panel offers connect only without a connected domain and surfaces failures',()=>{
 const free=siteDomainMarkup('acme',null,[{hostname:'acme.com'}],[{hostname:'acme.net',registration_state:'in_progress'}],escape);
 assert.match(free,/acme\.e2local\.com/);assert.match(free,/<option value="acme.com">/);assert.match(free,/data-refresh-domain="acme.net"/);
 const failed=siteDomainMarkup('acme',{hostname:'acme.com',connection_state:'failed',error_code:'CLOUDFLARE_500'},[{hostname:'acme.org'}],[],escape);
 assert.doesNotMatch(failed,/data-connect-form/);assert.match(failed,/data-connect-domain="acme.com"/);assert.match(failed,/CLOUDFLARE_500/);assert.match(failed,/data-disconnect-domain/);
 const live=siteDomainMarkup('acme',{hostname:'acme.com',connection_state:'connected'},[],[],escape);
 assert.match(live,/href="https:\/\/acme.com\/"/);assert.doesNotMatch(live,/Retry connection/);
});

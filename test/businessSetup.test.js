import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFromForm} from '../public/businessSetup.js';
import {priceEntry,profileEditorHtml} from '../public/businessProfileEditor.js';
test('profile editor preserves submitted values and unknown fields without changing the source',()=>{
 const source={businessName:'東京引越し',services:['Moving'],customFact:'Keep me'};
 const form=new FormData();form.set('businessName','  東京引越し  ');form.set('timeZone','Asia/Tokyo');
 form.set('services',' Moving\n\n Storage  ');form.set('locations','Tokyo');form.set('tone','friendly');
 const output=profileFromForm(form,source);
 assert.equal(output.businessName,'東京引越し');assert.deepEqual(output.services,['Moving','Storage']);
 assert.equal(output.customFact,'Keep me');assert.deepEqual(source.services,['Moving']);assert.equal(output.timeZone,'Asia/Tokyo');
});

test('guided entries serialize to the existing profile contract and allow clearing lists',()=>{
 const form=new FormData();form.set('profileEditor','guided');form.set('businessName','Real business');form.set('timeZone','UTC');
 form.append('servicesEntry',' Repair ');form.append('servicesEntry','');form.append('locationsEntry',' Denver ');
 form.append('faqQuestion','Do you offer quotes?');form.append('faqAnswer',' Yes, after reviewing the job. ');
 form.append('faqQuestion','');form.append('faqAnswer','Existing free-form FAQ stays intact.');
 form.append('pricingEntry','Repair: quoted individually.');form.set('bookingRules','Keep this custom rule.');
 const previous={services:['Old service'],policies:['Old policy'],customFact:{keep:true}};
 const result=profileFromForm(form,previous);
 assert.deepEqual(result.services,['Repair']);assert.deepEqual(result.locations,['Denver']);assert.deepEqual(result.policies,[]);
 assert.deepEqual(result.faqs,['Do you offer quotes? Yes, after reviewing the job.','Existing free-form FAQ stays intact.']);
 assert.deepEqual(result.pricing,['Repair: quoted individually.']);assert.equal(result.bookingRules,'Keep this custom rule.');
 assert.deepEqual(result.customFact,{keep:true});assert.deepEqual(previous.policies,['Old policy']);
});

test('pricing builder requires actual details and formats the selected pricing method',()=>{
 assert.equal(priceEntry({service:'Repair',method:'quote'}),'Repair: quoted individually.');
 assert.equal(priceEntry({service:'Repair',method:'from',amount:'50',details:'Materials extra'}),'Repair: from $50.00; Materials extra');
 assert.equal(priceEntry({service:'Repair',method:'hourly',amount:'0'}),'Repair: $0.00 per hour.');
 assert.equal(priceEntry({service:'Repair',method:'custom',details:'Quote after inspection.'}),'Repair: Quote after inspection.');
 assert.throws(()=>priceEntry({service:'',method:'quote'}),/service/);
 for(const amount of ['',-1,'bad',Infinity])assert.throws(()=>priceEntry({service:'Repair',method:'fixed',amount}),/valid price/);
 assert.throws(()=>priceEntry({service:'Repair',method:'custom'}),/Describe/);
});

test('guided editor retains saved content, escapes it, and does not preselect business facts',()=>{
 const html=profileEditorHtml({businessName:'<script>bad</script>',timeZone:'Asia/Tokyo',faqs:['Are you open? Yes.','Custom saved answer.'],pricing:['Special: €25'],hours:'Custom hours'});
 assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(html.includes('value="Asia/Tokyo" selected'));
 assert.ok(html.includes('value="Are you open?"'));assert.ok(html.includes('>Yes.</textarea>'));
 assert.ok(html.includes('Custom saved answer.'));assert.ok(html.includes('Special: €25'));assert.ok(html.includes('value="Custom hours"'));
 const empty=profileEditorHtml({});assert.ok(empty.includes('value="" checked'));assert.ok(empty.includes('value="" placeholder="Your real business'));
 assert.ok(!empty.includes('value="Mon–Fri')); // Presets are suggestions, never inserted as facts on load.
 const custom=profileEditorHtml({faqs:['Payment methods — Cash or card.','Can I reschedule?']});
 assert.ok(custom.includes('value="Payment methods"'));assert.ok(custom.includes('>Cash or card.</textarea>'));
 assert.ok(custom.includes('value="Can I reschedule?"'));
});

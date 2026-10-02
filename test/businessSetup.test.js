import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFromForm} from '../public/businessSetup.js';
test('profile editor preserves submitted values and unknown fields without changing the source',()=>{
 const source={businessName:'東京引越し',services:['Moving'],customFact:'Keep me'};
 const form=new FormData();form.set('businessName','  東京引越し  ');form.set('timeZone','Asia/Tokyo');
 form.set('services',' Moving\n\n Storage  ');form.set('locations','Tokyo');form.set('tone','friendly');
 const output=profileFromForm(form,source);
 assert.equal(output.businessName,'東京引越し');assert.deepEqual(output.services,['Moving','Storage']);
 assert.equal(output.customFact,'Keep me');assert.deepEqual(source.services,['Moving']);assert.equal(output.timeZone,'Asia/Tokyo');
});

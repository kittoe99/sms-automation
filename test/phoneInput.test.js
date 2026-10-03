import test from 'node:test';import assert from 'node:assert/strict';
import {normalizePhoneInput} from '../public/phoneInput.js';
import {profileFromForm} from '../public/businessProfileEditor.js';
test('local US/Canada phone input adds +1 once and accepts pasted punctuation',()=>{
 for(const value of ['7208429167','(720) 842-9167','720.842.9167','1 720 842 9167','+1 (720) 842-9167'])assert.equal(normalizePhoneInput(value),'+17208429167');
 assert.equal(normalizePhoneInput(normalizePhoneInput('7208429167')),'+17208429167');
});
test('explicit international numbers retain their country code; incomplete input is not guessed',()=>{
 assert.equal(normalizePhoneInput('+44 20 7946 0958'),'+442079460958');
 assert.equal(normalizePhoneInput('0044 20 7946 0958'),'+442079460958');
 for(const value of ['','7208429','02079460958','7208429167 ext 2','++17208429167'])assert.equal(normalizePhoneInput(value),value);
});
test('business profile serialization saves the same canonical phone as SMS forms',()=>{
 const form=new FormData();form.set('contactPhone','(720) 842-9167');assert.equal(profileFromForm(form).contactPhone,'+17208429167');
});

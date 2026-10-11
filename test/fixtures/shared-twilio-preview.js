// Synthetic visual QA only; no Twilio or database requests.
import express from 'express';
const app=express();
app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/e2-theme.css"><link rel="stylesheet" href="/dashboard-theme.css"><style>body{display:block;padding:24px;background:#f4f8fa}main{max-width:1080px;margin:auto}button{margin:4px}li{margin:8px 0}</style></head><body><main><h1>Shared Twilio account preview</h1><p>Synthetic records only</p><div id="directory"></div><div id="connection"></div><p id="result" role="status"></p></main><script type="module">
import {mountTwilioAccounts} from '/twilioAccounts.js';import {mountTwilioConnection} from '/twilioConnection.js';
const accountSid='AC'+'1'.repeat(32),number=(id,phone)=>({accountSid,phoneNumber:phone,phoneNumberSid:'PN'+id.repeat(32),messagingServiceSid:'MG'+id.repeat(32)});
const first={...number('2','+18775550180'),tenantId:'first',businessName:'First CRM Business'},second={...number('3','+18775550181'),tenantId:'second',businessName:'Second CRM Business'},pending={...number('4','+18775550182'),tenantId:'pending',businessName:'Pending CRM Business',state:'needs_review'};
const inventory={accounts:[{sid:accountSid,name:'Shared Twilio account',isParent:true,linkedBusinesses:[first,second],pendingConnections:[pending]}]};
const options=[{...first,assignedBusiness:first},{...pending,reservedBusiness:pending},number('5','+18775550183')].map(p=>({...p,profileName:'Approved Twilio profile',serviceName:'Service '+p.phoneNumber,approvalStatus:'Toll-free verified',senderType:'toll_free',registrationSid:'HH'+'6'.repeat(32),accountName:'Shared Twilio account'}));
const read=async(path)=>path==='twilio/accounts'?inventory:{options,connection:{revision:0},unavailable:[]};
const result=document.querySelector('#result');
await mountTwilioAccounts(document.querySelector('#directory'),{read,onBusiness:id=>result.textContent='Opened CRM business: '+id});
mountTwilioConnection(document.querySelector('#connection'),{tenant_id:'new',name:'New CRM Business',setup:{reviewed_profile_id:'reviewed'},services:[]},{read,write:async(path,p)=>{if(p.phoneNumberSid!==options[2].phoneNumberSid)throw Error('Occupied sender selected');result.textContent='Connected available sender to '+p.tenantId;},reload:async()=>{},onWorkspace:()=>{}});
</script></body></html>`));
app.use(express.static('public'));
app.listen(8094,'127.0.0.1',()=>console.log('Shared Twilio synthetic preview: http://localhost:8094'));

import React from 'react';
import {createRoot} from 'react-dom/client';
import {TwilioComplianceEmbed} from '@twilio/twilio-compliance-embed';

export function openComplianceEmbed({inquiryId,sessionToken,onSubmitted,onClose}) {
 const host=document.createElement('div');host.setAttribute('role','dialog');host.setAttribute('aria-modal','true');host.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);display:grid;place-items:center;padding:24px';
 const panel=document.createElement('div');panel.style.cssText='background:#fff;border-radius:16px;width:min(980px,100%);height:min(820px,calc(100vh - 48px));overflow:auto;box-shadow:0 24px 80px rgba(0,0,0,.28);position:relative';host.appendChild(panel);document.body.appendChild(host);const root=createRoot(panel);
 const close=()=>{root.unmount();host.remove();onClose?.();};host.addEventListener('click',event=>{if(event.target===host)close();});
 function Embed(){return React.createElement(React.Fragment,null,React.createElement('button',{type:'button',onClick:close,'aria-label':'Close registration',style:{position:'sticky',float:'right',top:12,right:12,zIndex:2,border:0,borderRadius:8,padding:'8px 12px',cursor:'pointer'}},'Close'),React.createElement(TwilioComplianceEmbed,{inquiryId,inquirySessionToken:sessionToken,onInquirySubmitted:()=>onSubmitted?.(),onComplete:close,onCancel:close,onError:()=>{},widgetPadding:{top:56,left:24,right:24,bottom:24}}));}
 root.render(React.createElement(Embed));return close;
}
globalThis.openTwilioComplianceEmbed=openComplianceEmbed;

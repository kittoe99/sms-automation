const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const states={connected:'Connected',in_progress:'In progress',needs_attention:'Needs attention',not_available:'Not available',approved:'Approved',active:'Messaging active',disabled:'Sending disabled',paused:'Paused'};
export function smsConnectionSummary(summary) {
 const text=value=>esc(value||'Not available');
 const status=value=>states[value]||'Not available';
 return `<section class="card sms-connection-summary" aria-labelledby="sms-connection-title">
  <div class="sms-summary-heading"><div><span class="twilio-eyebrow">SMS CONNECTION</span><h2 id="sms-connection-title">${text(summary.businessName)}</h2></div><span class="twilio-status">${status(summary.messagingStatus)}</span></div>
  <dl class="twilio-details"><div><dt>Business number</dt><dd>${text(summary.phoneNumber)}</dd></div>
   <div><dt>Connected profile</dt><dd>${text(summary.profileName)}</dd></div>
   <div><dt>Sender type</dt><dd>${summary.senderType==='toll_free'?'Verified toll-free':summary.senderType==='local_a2p'?'A2P 10DLC':'Not available'}</dd></div>
   <div><dt>Connection</dt><dd>${status(summary.connectionStatus)}</dd></div>
   <div><dt>Approval</dt><dd>${status(summary.approvalStatus)}</dd></div>
   <div><dt>Messaging</dt><dd>${status(summary.messagingStatus)}</dd></div></dl>
  <p class="muted">Connection details are read-only. Setup and activation are managed by our team.</p></section>`;
}

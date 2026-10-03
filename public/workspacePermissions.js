const readViews = new Set(['overview','messaging','contacts','optouts','deliverability','automations','call','messages','bookings']);
export function canOpenWorkspace(view, staff, tenant) {
  if (staff) return true;
  if (view === 'web-forms') return tenant?.smsRead === true || tenant?.formsManage === true;
  return tenant?.smsRead === true && readViews.has(view);
}
export function canWriteWorkspace(path, method, staff, tenant) {
  if (staff || ['GET','HEAD','OPTIONS'].includes(method.toUpperCase())) return true;
  return tenant?.formsManage === true && (
    method.toUpperCase() === 'POST' && (/^\/api\/web-forms$/.test(path) || /^\/api\/web-forms\/[0-9a-f-]{36}\/(duplicate|archive|restore)$/.test(path))
    || method.toUpperCase() === 'PUT' && /^\/api\/web-forms\/(contacts|quote_requests|bookings|[0-9a-f-]{36})$/.test(path));
}
export const staffActionSelector = [
  '#reply-form','#automation-intake-form','#ai-pause-btn','#compose-send','#call-place',
  '#edit-group-prompt','#edit-group-ai','#edit-group-email','#edit-automation-group',
  '#drawer-opt-in','#drawer-opt-out','#booking-cancel','.enroll-btn','.unenroll-btn','.compose-btn','.message-btn',
  '[data-opt-in]','[data-enrollment-id]','[data-edit-intake]','[data-reassign-message]',
  '[data-open-ai-instructions]','[data-open-business-context]','[data-complete-business-setup]',
  '[data-redraft-job]','[data-retry-job]',
].join(',');

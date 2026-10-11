// Lazy chunks use the same import specifiers as foreground navigation so the
// browser (and the production bundler) reuse a single module instance.
const modules = {
  'web-forms':()=>import('./formWorkspace.js?v=20261004-live-test'),
  'booking-setup':()=>import('./bookingSetup.js'),
  'voice-agent':()=>import('./voiceWorkspace.js'),
  'call':()=>import('./voiceWorkspace.js'),
  'inbound-ai':()=>import('./inboundAi.js'),
  'automation-activity':()=>import('./automationActivity.js'),
  platform:()=>import('./platform.js?v=20261003-directory'),
};
const firstPage = '?page=1&pageSize=50';
const reads = {
  overview:['/api/overview','/api/categories','/api/sms/connection','/api/web-forms'],
  'web-forms':['/api/web-forms'], contacts:['/api/categories','/api/directory'+firstPage],
  messaging:['/api/categories','/api/conversations'+firstPage], bookings:['/api/bookings'+firstPage],
  messages:['/api/categories','/api/messages'+firstPage], optouts:['/api/opt-outs'+firstPage],
  deliverability:['/api/deliverability'],
};
export function workspaceWarmupTasks(views, fetcher, loadModule = view => modules[view]?.()) {
  const tasks=[],seen=new Set();
  for(const view of views) {
    const module=view.startsWith('platform-')?'platform':view;
    if(!seen.has('code:'+module)){seen.add('code:'+module);if(modules[module])tasks.push(()=>loadModule(module));}
    const paths=['platform-accounts','platform-businesses','platform-websites'].includes(view)
      ? [`/api/platform/${view.slice(9)}?page=1&pageSize=25&q=`] : reads[view] || [];
    for(const path of paths)if(!seen.has(path)){
      seen.add(path);tasks.push(signal=>fetcher(path,{signal,tenant:!view.startsWith('platform-')}));
    }
  }
  return tasks;
}
export function workspaceIdle(signal) {
  return new Promise(resolve=>{
    let timer,idle;
    const cancel=()=>{clearTimeout(timer);if(idle!=null)globalThis.cancelIdleCallback?.(idle);};
    const finish=()=>{cancel();document.removeEventListener('visibilitychange',schedule);signal.removeEventListener('abort',finish);resolve();};
    const schedule=()=>{
      cancel();if(document.hidden)return;
      timer=setTimeout(()=>{
        if(globalThis.requestIdleCallback)idle=requestIdleCallback(finish,{timeout:1000});else finish();
      },200);
    };
    if(signal.aborted)return resolve();
    signal.addEventListener('abort',finish,{once:true});document.addEventListener('visibilitychange',schedule);schedule();
  });
}
export async function warmWorkspace(tasks,{signal,idle=workspaceIdle}={}) {
  for(const task of tasks) {
    await idle(signal);if(signal.aborted)return;
    try {const response=await task(signal);if([401,403].includes(response?.status))return;} catch {if(signal.aborted)return; /* A failed warmup never blocks navigation. */}
  }
}

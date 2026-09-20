(() => {
  const script=document.currentScript,id=script?.dataset.form;
  if(!/^[a-f0-9-]{36}$/i.test(id||''))return;
  const origin=new URL(script.src).origin,frame=document.createElement('iframe');
  frame.src=`${origin}/forms/${id}?parent=${encodeURIComponent(location.origin)}`;
  frame.title=script.dataset.title||'Request form';frame.loading='lazy';frame.style.cssText='display:block;width:100%;min-height:420px;border:0;';
  frame.referrerPolicy='strict-origin-when-cross-origin';
  const receive=event=>{if(event.origin!==origin||event.source!==frame.contentWindow||event.data?.type!=='sms-form-height'||event.data.form!==id)return;
    const height=Number(event.data.height);if(Number.isFinite(height))frame.style.height=Math.max(200,Math.min(12000,height))+'px';};
  window.addEventListener('message',receive);script.after(frame);
})();

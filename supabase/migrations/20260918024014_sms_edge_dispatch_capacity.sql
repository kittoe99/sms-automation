create or replace function sms_private.dispatch_edge() returns integer language plpgsql security definer set search_path='' as $$
declare cfg record; bearer text; request_id bigint; sent integer:=0; available integer; pending integer; begin
 perform sms_private.tick();
 if not (select edge_enabled from sms_private.runtime) then return 0; end if;
 if not pg_try_advisory_xact_lock(720491322) then return 0; end if;
 update sms_private.runtime set last_dispatch_at=now();
 for cfg in select c.* from sms_private.edge_config c where c.enabled and c.secret_id is not null
 and (c.last_requested_at is null or c.last_requested_at<=now()-interval '5 seconds')
 loop
  select greatest(0,cfg.max_concurrency-count(*))::integer into available from sms_private.edge_runs where queue=cfg.queue and expires_at>now();
  select count(*) into pending from (select 1 from sms_private.jobs j where j.queue=cfg.queue and j.status in ('queued','retry') and j.available_at<=now() limit available) ready;
  if pending=0 then continue; end if;
  select decrypted_secret into strict bearer from vault.decrypted_secrets where id=cfg.secret_id;
  for i in 1..least(available,pending) loop
   select net.http_post(
    url:='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/'||cfg.function_name,
    headers:=jsonb_build_object('Authorization','Bearer '||bearer,'Content-Type','application/json'),
    body:='{}'::jsonb,timeout_milliseconds:=110000) into request_id;
   sent:=sent+1;
  end loop;
  update sms_private.edge_config set last_requested_at=now() where queue=cfg.queue;
 end loop;
 return sent;
end $$;

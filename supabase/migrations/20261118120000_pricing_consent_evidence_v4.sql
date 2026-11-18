-- E2 /pricing has sent consentEvidence 'customer-service-sms-checkbox-v4' since September 27,
-- 2026 (E2 commit 8c011de), but submit_pricing_request still accepted only 'pricing-sms-v1',
-- so every pricing request failed with "Consent evidence is invalid". Accept both labels.
-- Only that one check changes; the rest of the live function body is preserved as-is.
do $migration$
declare
  definition text := pg_get_functiondef('public.submit_pricing_request(jsonb)'::regprocedure);
  old_check constant text := $$if request_evidence <> 'pricing-sms-v1' then raise exception 'Consent evidence is invalid'; end if;$$;
  new_check constant text := $$if request_evidence not in ('pricing-sms-v1', 'customer-service-sms-checkbox-v4') then raise exception 'Consent evidence is invalid'; end if;$$;
begin
  if position(new_check in definition) > 0 then return; end if;
  if position(old_check in definition) = 0 then
    raise exception 'submit_pricing_request changed; consent evidence check not found';
  end if;
  execute replace(definition, old_check, new_check);
end
$migration$;

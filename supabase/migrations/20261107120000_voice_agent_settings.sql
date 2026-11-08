-- CRM-owned forward migration. Requires CRM 20261031100908 (voice prompt length unlimited)
-- and 20261016203800 (MCP voice management). No E2 Local prerequisite: E2 Local does not
-- read or write voice configurations.
--
-- Adds an optional "settings" object to voice configurations: greeting and recording
-- disclosure, closing, language, conversation style and pronunciations, silence check-ins,
-- maximum call length, escalation, capability opt-outs, backend reasoning and audio
-- recording. Every key is optional and absent keys keep the existing call behavior, so
-- previously saved drafts and published revisions remain valid unchanged. The contract
-- mirrors public/voiceSettings.js and src/mcp/voiceSchemas.js.

create or replace function sms_private.validate_voice_settings(s jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
 spec constant jsonb:='{
  "greeting":{"spokenName":["text",60],"message":["text",1000],"recordingDisclosure":["bool"],"disclosureText":["text",500]},
  "closing":{"message":["text",1000]},
  "language":{"primary":["enum",["en","es","pt","fr","de","tl"]],"allowSwitching":["bool"]},
  "conversation":{"responseStyle":["enum",["brief","balanced","detailed"]],"allowInterruptions":["bool"],"pronunciations":["pronunciations"]},
  "silence":{"enabled":["bool"],"seconds":["int",5,120],"message":["text",300],"hangUpAfter":["int",0,5]},
  "limits":{"maxCallMinutes":["int",0,120],"wrapUpMessage":["text",500]},
  "escalation":{"message":["text",1000],"offerCallback":["bool"]},
  "capabilities":{"lookups":["bool"],"bookings":["bool"],"inCallSms":["bool"]},
  "backend":{"reasoningEffort":["enum",["low","medium","high"]],"serviceTier":["enum",["priority","default"]]},
  "recording":{"audio":["bool"]}
 }';
 g record; f record; rule jsonb; p jsonb;
begin
 if jsonb_typeof(s) is distinct from 'object' then return false; end if;
 for g in select key,value from jsonb_each(s) loop
  if not spec ? g.key or jsonb_typeof(g.value) is distinct from 'object' then return false; end if;
  for f in select key,value from jsonb_each(g.value) loop
   rule:=spec->g.key->f.key;
   if rule is null then return false; end if;
   case rule->>0
    when 'text' then
     if jsonb_typeof(f.value)<>'string' or length(f.value#>>'{}')>(rule->>1)::int then return false; end if;
    when 'bool' then
     if jsonb_typeof(f.value)<>'boolean' then return false; end if;
    when 'enum' then
     if jsonb_typeof(f.value)<>'string' or not (rule->1) ? (f.value#>>'{}') then return false; end if;
    when 'int' then
     if jsonb_typeof(f.value)<>'number' or (f.value#>>'{}')::numeric<>trunc((f.value#>>'{}')::numeric)
      or (f.value#>>'{}')::numeric not between (rule->>1)::numeric and (rule->>2)::numeric then return false; end if;
    when 'pronunciations' then
     if jsonb_typeof(f.value)<>'array' or jsonb_array_length(f.value)>50 then return false; end if;
     for p in select value from jsonb_array_elements(f.value) loop
      if jsonb_typeof(p)<>'object' or exists(select from jsonb_object_keys(p) k where k not in ('term','sayAs'))
       or jsonb_typeof(p->'term') is distinct from 'string' or length(btrim(p->>'term')) not between 1 and 80
       or jsonb_typeof(p->'sayAs') is distinct from 'string' or length(btrim(p->>'sayAs')) not between 1 and 120
      then return false; end if;
     end loop;
    else return false;
   end case;
  end loop;
 end loop;
 return true;
end $$;

create or replace function sms_private.validate_voice_configuration(p jsonb) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or exists(select from jsonb_object_keys(p) k where k not in ('name','persona','voice','brain','voiceName','settings'))
 or jsonb_typeof(p->'name') is distinct from 'string' or length(btrim(p->>'name')) not between 1 and 100
 or jsonb_typeof(p->'persona') is distinct from 'string'
 or jsonb_typeof(p->'voice') is distinct from 'string' or btrim(p->>'voice')=''
 or jsonb_typeof(p->'brain') is distinct from 'string' or btrim(p->>'brain')=''
 or coalesce(p->>'voiceName','') not in ('marin','quartz','ripple','vesper','willow','stone','gleam','meridian','bossa','tempo','beacon','delta','cinder')
 then raise exception 'Configuration: provide name, persona, both prompts and a supported voice'; end if;
 if p ? 'settings' and not sms_private.validate_voice_settings(p->'settings')
 then raise exception 'Configuration: voice agent settings are not supported or out of range'; end if;
end $$;

revoke all on function sms_private.validate_voice_settings(jsonb) from public,anon,authenticated,service_role;

update sms_private.mcp_input_schemas
set schema=jsonb_set(schema,'{properties,configuration,properties,settings}','{"type":"object","properties":{"greeting":{"type":"object","properties":{"spokenName":{"type":"string","maxLength":60},"message":{"type":"string","maxLength":1000},"recordingDisclosure":{"type":"boolean"},"disclosureText":{"type":"string","maxLength":500}},"additionalProperties":false},"closing":{"type":"object","properties":{"message":{"type":"string","maxLength":1000}},"additionalProperties":false},"language":{"type":"object","properties":{"primary":{"type":"string","enum":["en","es","pt","fr","de","tl"]},"allowSwitching":{"type":"boolean"}},"additionalProperties":false},"conversation":{"type":"object","properties":{"responseStyle":{"type":"string","enum":["brief","balanced","detailed"]},"allowInterruptions":{"type":"boolean"},"pronunciations":{"type":"array","items":{"type":"object","properties":{"term":{"type":"string","minLength":1,"maxLength":80},"sayAs":{"type":"string","minLength":1,"maxLength":120}},"required":["term","sayAs"],"additionalProperties":false},"maxItems":50}},"additionalProperties":false},"silence":{"type":"object","properties":{"enabled":{"type":"boolean"},"seconds":{"type":"integer","minimum":5,"maximum":120},"message":{"type":"string","maxLength":300},"hangUpAfter":{"type":"integer","minimum":0,"maximum":5}},"additionalProperties":false},"limits":{"type":"object","properties":{"maxCallMinutes":{"type":"integer","minimum":0,"maximum":120},"wrapUpMessage":{"type":"string","maxLength":500}},"additionalProperties":false},"escalation":{"type":"object","properties":{"message":{"type":"string","maxLength":1000},"offerCallback":{"type":"boolean"}},"additionalProperties":false},"capabilities":{"type":"object","properties":{"lookups":{"type":"boolean"},"bookings":{"type":"boolean"},"inCallSms":{"type":"boolean"}},"additionalProperties":false},"backend":{"type":"object","properties":{"reasoningEffort":{"type":"string","enum":["low","medium","high"]},"serviceTier":{"type":"string","enum":["priority","default"]}},"additionalProperties":false},"recording":{"type":"object","properties":{"audio":{"type":"boolean"}},"additionalProperties":false}},"additionalProperties":false}'::jsonb)
where tool in ('crm_create_voice_agent','crm_save_voice_draft');

do $$ begin
 if (select count(*) from sms_private.mcp_input_schemas
     where tool in ('crm_create_voice_agent','crm_save_voice_draft')
       and schema #> '{properties,configuration,properties,settings,properties,greeting}' is not null) <> 2
 then raise exception 'Voice draft schemas were not updated'; end if;
end $$;

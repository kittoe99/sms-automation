-- CRM-owned forward migration. Requires CRM 20261016203800 (MCP voice management).
-- Voice agent prompts have no length limit: persona, voice and brain lose their maximum
-- lengths. Voice and brain must still be non-blank; the display name stays 1 to 100.

create or replace function sms_private.validate_voice_configuration(p jsonb) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or exists(select from jsonb_object_keys(p) k where k not in ('name','persona','voice','brain','voiceName'))
 or jsonb_typeof(p->'name') is distinct from 'string' or length(btrim(p->>'name')) not between 1 and 100
 or jsonb_typeof(p->'persona') is distinct from 'string'
 or jsonb_typeof(p->'voice') is distinct from 'string' or btrim(p->>'voice')=''
 or jsonb_typeof(p->'brain') is distinct from 'string' or btrim(p->>'brain')=''
 or coalesce(p->>'voiceName','') not in ('marin','quartz','ripple','vesper','willow','stone','gleam','meridian','bossa','tempo','beacon','delta','cinder')
 then raise exception 'Configuration: provide name, persona, both prompts and a supported voice'; end if;
end $$;

update sms_private.mcp_input_schemas
set schema=schema
  #- '{properties,configuration,properties,persona,maxLength}'
  #- '{properties,configuration,properties,voice,maxLength}'
  #- '{properties,configuration,properties,brain,maxLength}'
where tool in ('crm_create_voice_agent','crm_save_voice_draft');

do $$ begin
 if (select count(*) from sms_private.mcp_input_schemas
     where tool in ('crm_create_voice_agent','crm_save_voice_draft')
       and schema #> '{properties,configuration,properties,voice,minLength}' is not null) <> 2
 then raise exception 'Voice draft schemas were not found'; end if;
end $$;

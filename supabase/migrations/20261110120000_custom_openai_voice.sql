-- CRM-owned forward migration. Requires CRM 20261107120000_voice_agent_settings.sql.
-- Adds the custom OpenAI voice "My new voice" (voice_6af2d134d92081918a68df7cf07fad38)
-- to the supported Voice Agent voices. Mirrors public/voiceWorkspace.js (VOICES) and
-- src/mcp/voiceSchemas.js (voiceName enum). No E2 Local prerequisite.

create or replace function sms_private.validate_voice_configuration(p jsonb) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or exists(select from jsonb_object_keys(p) k where k not in ('name','persona','voice','brain','voiceName','settings'))
 or jsonb_typeof(p->'name') is distinct from 'string' or length(btrim(p->>'name')) not between 1 and 100
 or jsonb_typeof(p->'persona') is distinct from 'string'
 or jsonb_typeof(p->'voice') is distinct from 'string' or btrim(p->>'voice')=''
 or jsonb_typeof(p->'brain') is distinct from 'string' or btrim(p->>'brain')=''
 or coalesce(p->>'voiceName','') not in ('marin','quartz','ripple','vesper','willow','stone','gleam','meridian','bossa','tempo','beacon','delta','cinder','voice_6af2d134d92081918a68df7cf07fad38')
 then raise exception 'Configuration: provide name, persona, both prompts and a supported voice'; end if;
 if p ? 'settings' and not sms_private.validate_voice_settings(p->'settings')
 then raise exception 'Configuration: voice agent settings are not supported or out of range'; end if;
end $$;

update sms_private.mcp_input_schemas
set schema=jsonb_set(schema,'{properties,configuration,properties,voiceName,enum}',
 '["marin","quartz","ripple","vesper","willow","stone","gleam","meridian","bossa","tempo","beacon","delta","cinder","voice_6af2d134d92081918a68df7cf07fad38"]'::jsonb)
where tool in ('crm_create_voice_agent','crm_save_voice_draft');

do $$ begin
 if (select count(*) from sms_private.mcp_input_schemas
     where tool in ('crm_create_voice_agent','crm_save_voice_draft')
       and schema #> '{properties,configuration,properties,voiceName,enum}' ? 'voice_6af2d134d92081918a68df7cf07fad38') <> 2
 then raise exception 'Voice draft schemas were not updated'; end if;
end $$;

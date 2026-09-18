create unique index providers_messaging_service_sid_unique
  on sms_private.providers (messaging_service_sid)
  where messaging_service_sid is not null;

create unique index providers_auth_secret_id_unique
  on sms_private.providers (auth_secret_id)
  where auth_secret_id is not null;

alter table sms_private.providers
  add constraint providers_account_sid_format
    check (account_sid is null or account_sid ~ '^AC[0-9A-Fa-f]{32}$'),
  add constraint providers_messaging_service_sid_format
    check (messaging_service_sid is null or messaging_service_sid ~ '^MG[0-9A-Fa-f]{32}$'),
  add constraint providers_account_requires_auth_secret
    check (account_sid is null or auth_secret_id is not null);


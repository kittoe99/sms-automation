-- Clerk assigns a new subject when an account moves from development to production.
-- This is the verified production user for the existing CRM administrator.
insert into sms_private.admins (clerk_user_id)
values ('user_3JkKryIIC3wMQ1SN7oYAh59hL6B')
on conflict (clerk_user_id) do nothing;

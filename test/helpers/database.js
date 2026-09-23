import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir } from 'node:fs/promises';
export async function testDatabase({beforeMigration}={}) {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create schema pgmq; create table pgmq.test_messages(id bigint generated always as identity primary key,q text,message jsonb,vt timestamptz default now());
 create function pgmq.create(text) returns void language sql as $$ select $$;
 create function pgmq.send(text,jsonb,integer default 0) returns bigint language sql as $$ insert into pgmq.test_messages(q,message,vt) values($1,$2,now()+make_interval(secs=>$3)) returning id $$;
 create function pgmq.read(text,integer,integer) returns table(msg_id bigint,message jsonb) language sql as $$ update pgmq.test_messages set vt=now()+make_interval(secs=>$2) where id in(select id from pgmq.test_messages where q=$1 and vt<=now() order by id limit $3) returning id,message $$;
 create function pgmq.delete(text,bigint) returns boolean language sql as $$ delete from pgmq.test_messages where q=$1 and id=$2 returning true $$;
 create function pgmq.set_vt(text,bigint,integer) returns boolean language sql as $$ update pgmq.test_messages set vt=now()+make_interval(secs=>$3) where q=$1 and id=$2 returning true $$;
 create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
 create schema net; create table net.test_requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
 create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 2000) returns bigint language sql as $$ insert into net.test_requests(url,headers,body) values($1,$4,$2) returning id $$;
 create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid());
 create table vault.decrypted_secrets(id uuid primary key default gen_random_uuid(),decrypted_secret text);
 create function vault.create_secret(text) returns uuid language sql as $$ insert into vault.decrypted_secrets(decrypted_secret) values($1) returning id $$;
 create table public.users(id text primary key); create table public.businesses(business_id uuid primary key,owner_clerk_user_id text references public.users); create table public.contacts(contact_id uuid primary key,name text);
 insert into public.users values('website-user'); insert into public.contacts values(gen_random_uuid(),'Website contact');`);
 const dir=new URL('../../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort()) {
   if(beforeMigration) await beforeMigration(db,file);
   let migration=await readFile(new URL(file,dir),'utf8');
   migration=migration
    .replace(/^create extension[^;]+;/gm,'')
    // PGlite does not bundle pgvector. Production keeps the vector column/index;
    // SQL tests use real[] and exercise the tenant/approval/keyword path.
    .replace(/-- PGLITE_VECTOR_BEGIN[\s\S]*?-- PGLITE_VECTOR_END/g,
      'alter table public.sms_knowledge_chunks add column embedding real[];');
   await db.exec(migration);
 }
 await db.exec(`grant sms_sender,sms_automation,sms_ai to postgres; insert into sms_private.admins values('admin') on conflict do nothing;`);
 return db;
}
export async function call(db,name,...args) {
 return (await db.query(`select sms_private.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args.map(x=>typeof x==='object' && x!==null?JSON.stringify(x):x))).rows[0].value;
}

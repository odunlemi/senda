import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" boolean not null default false,
      "image" text,
      "createdAt" timestamptz default current_timestamp not null,
      "updatedAt" timestamptz default current_timestamp not null
    )
  `.execute(db);

  await sql`
    create table "session" (
      "id" text not null primary key,
      "expiresAt" timestamptz not null,
      "token" text not null unique,
      "createdAt" timestamptz default current_timestamp not null,
      "updatedAt" timestamptz default current_timestamp not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references "user" ("id") on delete cascade
    )
  `.execute(db);

  await sql`
    create table "account" (
      "id" text not null primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references "user" ("id") on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      "scope" text,
      "password" text,
      "createdAt" timestamptz default current_timestamp not null,
      "updatedAt" timestamptz default current_timestamp not null
    )
  `.execute(db);

  await sql`
    create table "verification" (
      "id" text not null primary key,
      "identifier" text not null,
      "value" text not null,
      "expiresAt" timestamptz not null,
      "createdAt" timestamptz default current_timestamp not null,
      "updatedAt" timestamptz default current_timestamp not null
    )
  `.execute(db);

  await sql`create index "session_userId_idx" on "session" ("userId")`.execute(db);
  await sql`create index "account_userId_idx" on "account" ("userId")`.execute(db);
  await sql`create index "verification_identifier_idx" on "verification" ("identifier")`.execute(
    db,
  );
  await sql`
    alter table "paymentIntents"
    add constraint "paymentIntents_merchantId_fkey"
    foreign key ("merchantId") references "user" ("id") on delete restrict
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    drop constraint if exists "paymentIntents_merchantId_fkey"
  `.execute(db);
  await sql`drop table if exists "account"`.execute(db);
  await sql`drop table if exists "session"`.execute(db);
  await sql`drop table if exists "verification"`.execute(db);
  await sql`drop table if exists "user"`.execute(db);
}

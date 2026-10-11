-- Rove database (Supabase Postgres). Owner: Nithya. Mirrors packages/shared/src/domain.ts.
-- Apply in the Supabase SQL editor, or: psql "$DATABASE_URL" -f packages/db/schema.sql, or: pnpm --filter @rove/db migrate
-- Idempotent: safe to re-apply after every change (create … if not exists, add column if not exists, create or replace).
-- Amounts are numeric, never float. Local currency has 2 decimals; USD quotes keep 6.

-- ------------------------------------------------------------ shops

create table if not exists merchants (
  id                text primary key,                          -- slug, e.g. 'ahseng'
  name              text not null,
  phone             text not null unique,                      -- E.164; the agent DMs the merchant here
  channel           text not null check (channel in ('imessage','whatsapp')),
  category          text,
  country           text not null default 'SG',
  currency          text not null default 'SGD',
  xrpl_address      text unique,                               -- custodial account holding the merchant's XSGD
  xrpl_seed_enc     text,                                      -- AES-256-GCM with WALLET_ENCRYPTION_KEY (demo custody only)
  credential_status text not null default 'none' check (credential_status in ('none','issued','accepted')),
  auto_withdraw     text not null default 'off' check (auto_withdraw in ('off','daily')),
  status            text not null default 'draft' check (status in ('draft','live')),
  created_at        timestamptz not null default now()
);

create table if not exists menu_items (
  id          text primary key,                                -- item_<hex>
  merchant_id text not null references merchants(id),
  name        text not null,
  price       numeric(18,2) not null check (price > 0),
  currency    text not null,
  active      boolean not null default true,
  sort        int not null default 0,
  unique (merchant_id, name)
);

create table if not exists contacts (
  id          text primary key,                                -- ct_<hex>
  merchant_id text not null references merchants(id),
  name        text not null,
  phone       text not null,
  channel     text check (channel in ('imessage','whatsapp')),
  created_at  timestamptz not null default now(),
  unique (merchant_id, phone)
);

-- ------------------------------------------------------------ getting paid

create table if not exists invoices (
  id          text primary key,                                -- inv_<hex>
  code        text not null unique,                            -- public short code, /pay/<code>
  merchant_id text not null references merchants(id),
  kind        text not null check (kind in ('invoice','one_time_qr','pay_request')),
  contact_id  text references contacts(id),
  to_phone    text,
  to_channel  text check (to_channel in ('imessage','whatsapp')),
  lines       jsonb not null default '[]',                     -- InvoiceLine[]
  total       numeric(18,2) not null check (total > 0),
  currency    text not null,
  note        text,
  status      text not null default 'open' check (status in ('open','paid','expired','cancelled')),
  expires_at  timestamptz not null,
  payment_id  text,
  reminded_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invoices_merchant_open on invoices (merchant_id) where status = 'open';
create index if not exists invoices_to_phone_open on invoices (to_phone) where status = 'open';

create table if not exists payments (
  id                    text primary key,                      -- pay_<hex>
  merchant_id           text not null references merchants(id),
  source                text not null check (source in ('invoice','one_time_qr','fixed_qr','pay_request')),
  invoice_id            text references invoices(id),
  lines                 jsonb not null default '[]',
  amount_local          numeric(18,2) not null check (amount_local > 0),
  currency              text not null,
  quote_usd             numeric(18,6),
  quote_rate            numeric(18,8),
  quote_send_max_usd    numeric(18,6),
  quote_expires_at      timestamptz,
  charge_amount         numeric(18,2),                         -- what the payer was charged, in their own currency
  charge_currency       text,                                  -- 'USD' | 'SGD' (the card leg never converts)
  method                text not null check (method in ('apple_pay','card','bnb','ausd')),
  status                text not null default 'created'
                        check (status in ('created','authorized','settling','settled','partially_refunded','refunded','failed')),
  payer_phone           text,
  payer_channel         text check (payer_channel in ('imessage','whatsapp')),
  stripe_payment_intent text unique,
  bnb_deposit_address   text unique,
  payin_tx_hash         text,
  settle_tx_hash        text,
  delivered_amount      numeric(18,6),                         -- meta.delivered_amount
  refunded_local        numeric(18,2) not null default 0,
  failure_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists payments_merchant_created on payments (merchant_id, created_at desc);
-- at most one successful payment per invoice (one-time QRs and invoices are single use)
create unique index if not exists payments_one_per_invoice on payments (invoice_id)
  where invoice_id is not null and status in ('authorized','settling','settled','partially_refunded','refunded');

create table if not exists refunds (
  id               text primary key,                           -- ref_<hex>
  payment_id       text not null references payments(id),
  merchant_id      text not null references merchants(id),
  action_id        text not null unique,                       -- one refund per confirmed action
  amount_local     numeric(18,2) not null check (amount_local > 0),
  currency         text not null,
  status           text not null default 'pending' check (status in ('pending','completed','failed')),
  stripe_refund_id text,
  xrpl_tx_hash     text,
  failure_reason   text,
  created_at       timestamptz not null default now()
);

-- ------------------------------------------------------------ balance + withdrawals

-- Append-only. available = Σ payment_credit + Σ withdrawal_release + Σ withdrawal_return − Σ refund_debit − Σ withdrawal_hold
--              held      = Σ withdrawal_hold − Σ withdrawal_release − Σ withdrawal_debit
-- available + held must equal the XSGD balance on the merchant's XRPL account (the reconciler checks).
create table if not exists ledger_entries (
  id          text primary key,                                -- led_<hex>
  merchant_id text not null references merchants(id),
  kind        text not null check (kind in ('payment_credit','refund_debit','withdrawal_hold','withdrawal_release','withdrawal_debit','withdrawal_return')),
  amount      numeric(18,2) not null check (amount > 0),
  currency    text not null,
  ref         text not null,
  created_at  timestamptz not null default now(),
  unique (kind, ref)                                           -- idempotency: one entry per kind per object
);
create index if not exists ledger_merchant on ledger_entries (merchant_id);

-- security_invoker: the view obeys the caller's RLS (see the end of this file), so it can't leak balances via the Data API.
create or replace view merchant_balances with (security_invoker = true) as
select merchant_id,
  coalesce(sum(case kind when 'payment_credit' then amount when 'withdrawal_release' then amount
                         when 'withdrawal_return' then amount when 'refund_debit' then -amount when 'withdrawal_hold' then -amount else 0 end), 0) as available,
  coalesce(sum(case kind when 'withdrawal_hold' then amount when 'withdrawal_release' then -amount
                         when 'withdrawal_debit' then -amount else 0 end), 0) as held
from ledger_entries group by merchant_id;

create table if not exists bank_accounts (
  id             text primary key,                             -- bank_<hex>
  merchant_id    text not null references merchants(id),
  type           text not null check (type in ('paynow_uen','paynow_mobile','bank_account')),
  bank_name      text,
  last4          text not null,
  holder_name    text not null,                                -- name returned by the partner's name check
  beneficiary_id text not null,                                -- payout partner id; full numbers are NOT stored
  status         text not null check (status in ('verified','pending','failed')),
  is_default     boolean not null default true,
  created_at     timestamptz not null default now()
);

create table if not exists withdrawals (
  id                 text primary key,                         -- wd_<hex>
  merchant_id        text not null references merchants(id),
  amount_local       numeric(18,2) not null check (amount_local > 0),
  fee_local          numeric(18,2) not null default 0,
  currency           text not null,
  destination_kind   text not null check (destination_kind in ('bank','xrpl_wallet')),
  bank_account_id    text references bank_accounts(id),
  wallet_address     text,
  status             text not null default 'requested'
                     check (status in ('requested','approved','onchain_pending','onchain_settled','payout_pending','completed','failed','returned','cancelled')),
  needs_step_up      boolean not null default false,
  action_id          text unique,
  sweep_tx_hash      text,
  partner_payout_id  text,
  bank_ref           text,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists withdrawals_merchant on withdrawals (merchant_id, created_at desc);

-- ------------------------------------------------------------ agent

create table if not exists pending_actions (
  id                  text primary key,                        -- act_<hex>
  merchant_id         text not null references merchants(id),
  kind                text not null check (kind in ('refund','withdrawal','set_auto_withdraw')),
  args                jsonb not null,
  status              text not null default 'proposed'
                      check (status in ('proposed','executing','done','expired','failed','cancelled')),
  confirm_message_ids text[] not null default '{}',
  expires_at          timestamptz not null,
  result              jsonb,
  created_at          timestamptz not null default now(),
  executed_at         timestamptz
);
create index if not exists pending_actions_open on pending_actions (merchant_id) where status = 'proposed';

create table if not exists agent_messages (
  id          bigserial primary key,
  phone       text not null,
  persona     text not null check (persona in ('merchant','customer')),
  merchant_id text references merchants(id),
  role        text not null check (role in ('user','assistant')),
  content     text not null,                                   -- plain text only; append-only
  channel     text not null check (channel in ('imessage','whatsapp')),
  created_at  timestamptz not null default now()
);
create index if not exists agent_messages_phone on agent_messages (phone, id desc);

-- Onboarding state per phone (shops being set up over chat)
create table if not exists onboarding (
  phone       text primary key,
  channel     text not null,
  step        text not null,                                   -- 'name' | 'category' | 'menu' | 'bank' | 'done'
  data        jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ plumbing

-- Idempotency: stripe event ids, spectrum message ids, event envelope ids, bsc logs.
create table if not exists processed (
  key text primary key,
  at  timestamptz not null default now()
);

create or replace function claim(k text) returns boolean language plpgsql as $$
begin
  insert into processed(key) values (k);
  return true;
exception when unique_violation then
  return false;
end $$;

create table if not exists events (
  id      text primary key,                                    -- envelope id evt_<hex>
  type    text not null,
  payload jsonb not null,
  at      timestamptz not null default now()
);

-- ------------------------------------------------------------ additions (NI-B1)
-- Everything below is idempotent: `pnpm --filter @rove/db migrate` re-applies this whole file safely.

-- the agent acks each envelope; boot-time replay sends the rest (listUndeliveredEvents)
alter table events add column if not exists delivered_at timestamptz;
create index if not exists events_undelivered on events (at) where delivered_at is null;

-- per-payment BSC deposit address index, m/44'/60'/0'/0/<n> (nextDepositIndex); never reused, 0 left for the collector
create sequence if not exists bsc_deposit_index start with 1 minvalue 1;

-- lookups the services make
create index if not exists payments_payer_phone on payments (payer_phone, created_at desc) where payer_phone is not null;
create index if not exists payments_status_updated on payments (status, updated_at);
create index if not exists ledger_merchant_kind_created on ledger_entries (merchant_id, kind, created_at);
create index if not exists withdrawals_status on withdrawals (status, created_at);
create index if not exists pending_actions_confirm_ids on pending_actions using gin (confirm_message_ids);

-- Lock the tables away from Supabase's Data API (anon / authenticated roles). Services connect as the table owner
-- through DATABASE_URL, which bypasses RLS; with no policies, every other role sees nothing.
alter table merchants       enable row level security;
alter table menu_items      enable row level security;
alter table contacts        enable row level security;
alter table invoices        enable row level security;
alter table payments        enable row level security;
alter table refunds         enable row level security;
alter table ledger_entries  enable row level security;
alter table bank_accounts   enable row level security;
alter table withdrawals     enable row level security;
alter table pending_actions enable row level security;
alter table agent_messages  enable row level security;
alter table onboarding      enable row level security;
alter table processed       enable row level security;
alter table events          enable row level security;

-- AUSD lane: allow the new payment method on databases created before it existed.
alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check check (method in ('apple_pay','card','bnb','ausd'));

-- ------------------------------------------------------------ AUSD lane (docs/specs/ausd-lane.md)
-- The payer's signed ERC-3009 TransferWithAuthorization (Agora AUSD on Base Sepolia), stored by POST /api/ausd/authorize or the
-- x402 route; the worker relayer submits it and pays the gas. uint256 values are numeric(78,0): exact, never float.
alter table payments add column if not exists ausd_from           text;          -- payer (the authorizer)
alter table payments add column if not exists ausd_to             text;          -- Rove's AUSD_PAY_TO
alter table payments add column if not exists ausd_value          numeric(78,0); -- token base units (AUSD has 6 decimals)
alter table payments add column if not exists ausd_valid_after    numeric(78,0); -- unix seconds
alter table payments add column if not exists ausd_valid_before   numeric(78,0); -- unix seconds
alter table payments add column if not exists ausd_nonce          text;          -- bytes32 hex
alter table payments add column if not exists ausd_signature      text;          -- 65-byte hex
alter table payments add column if not exists ausd_relay_tx_hash  text;          -- recorded before broadcast, so a restart finds it
alter table payments add column if not exists ausd_relay_attempts int not null default 0;
-- one authorization pays one payment (ERC-3009 nonces are per authorizer); one relay tx belongs to one payment
create unique index if not exists payments_ausd_nonce on payments (lower(ausd_from), lower(ausd_nonce)) where ausd_nonce is not null;
create unique index if not exists payments_ausd_relay_tx on payments (lower(ausd_relay_tx_hash)) where ausd_relay_tx_hash is not null;
create index if not exists payments_ausd_awaiting_relay on payments (updated_at)
  where method = 'ausd' and status = 'created' and ausd_signature is not null;

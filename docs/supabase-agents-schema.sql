-- Agent Launchpad: Agents/Messages/Runs schema.
-- Run once in Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to re-run: every statement is idempotent.

create table if not exists public.agents (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  instructions text not null default '',
  status text not null default 'ready'
    check (status in ('ready', 'busy', 'stopped', 'error')),
  codex_thread_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key,
  agent_id uuid not null references public.agents(id) on delete cascade,
  run_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.runs (
  id uuid primary key,
  agent_id uuid not null references public.agents(id) on delete cascade,
  status text not null default 'queued'
    check (status in (
      'queued', 'running', 'completed', 'failed', 'cancelled',
      'blocked', 'pending_confirmation', 'discarded'
    )),
  prompt text not null,
  output text,
  error text,
  usage jsonb,
  scan jsonb,
  pending_changes jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- The two blocks below make the schema safe to re-run against a table that
-- already existed before the prompt-injection-scan and confirmation-gate
-- features: add the new columns if missing, and widen the status check
-- constraint to accept the new statuses those features introduce.
alter table public.runs add column if not exists scan jsonb;
alter table public.runs add column if not exists pending_changes jsonb;

alter table public.runs drop constraint if exists runs_status_check;
alter table public.runs add constraint runs_status_check
  check (status in (
    'queued', 'running', 'completed', 'failed', 'cancelled',
    'blocked', 'pending_confirmation', 'discarded'
  ));

create index if not exists agents_owner_id_idx on public.agents(owner_id);
create index if not exists messages_agent_id_idx on public.messages(agent_id);
create index if not exists runs_agent_id_idx on public.runs(agent_id);

-- The app's server uses the service_role key, which bypasses RLS, and
-- enforces owner_id filters itself (see supabase-repository.ts). These
-- policies are defense-in-depth: if these tables are ever queried directly
-- from the browser with a user's own session, they still can't see or
-- touch another account's rows.
alter table public.agents enable row level security;
alter table public.messages enable row level security;
alter table public.runs enable row level security;

drop policy if exists "Owners manage their agents" on public.agents;
create policy "Owners manage their agents" on public.agents
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "Owners read their agent messages" on public.messages;
create policy "Owners read their agent messages" on public.messages
  for select
  using (exists (
    select 1 from public.agents a where a.id = agent_id and a.owner_id = auth.uid()
  ));

drop policy if exists "Owners insert their agent messages" on public.messages;
create policy "Owners insert their agent messages" on public.messages
  for insert
  with check (exists (
    select 1 from public.agents a where a.id = agent_id and a.owner_id = auth.uid()
  ));

drop policy if exists "Owners read their agent runs" on public.runs;
create policy "Owners read their agent runs" on public.runs
  for select
  using (exists (
    select 1 from public.agents a where a.id = agent_id and a.owner_id = auth.uid()
  ));

drop policy if exists "Owners insert their agent runs" on public.runs;
create policy "Owners insert their agent runs" on public.runs
  for insert
  with check (exists (
    select 1 from public.agents a where a.id = agent_id and a.owner_id = auth.uid()
  ));

drop policy if exists "Owners update their agent runs" on public.runs;
create policy "Owners update their agent runs" on public.runs
  for update
  using (exists (
    select 1 from public.agents a where a.id = agent_id and a.owner_id = auth.uid()
  ));

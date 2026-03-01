-- 015: Team Templates — saved space structure templates
-- Stores user-created templates with JSONB structure for reuse

create table if not exists public.team_templates (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text not null default '',
    owner_id uuid not null references auth.users(id) on delete cascade,
    shared boolean not null default false,
    structure jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- RLS
alter table public.team_templates enable row level security;

-- Owner has full CRUD
create policy "team_templates_owner_all"
    on public.team_templates
    for all
    using (auth.uid() = owner_id)
    with check (auth.uid() = owner_id);

-- Shared templates readable by all authenticated users
create policy "team_templates_shared_read"
    on public.team_templates
    for select
    using (shared = true and auth.role() = 'authenticated');

-- Index for listing
create index if not exists idx_team_templates_owner on public.team_templates(owner_id);
create index if not exists idx_team_templates_shared on public.team_templates(shared) where shared = true;

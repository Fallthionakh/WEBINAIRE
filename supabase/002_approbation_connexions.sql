-- WEBINAIRE – migration 002 : approbation des comptes et historique des connexions
-- À exécuter une seule fois, après schema.sql : Supabase → SQL Editor → New query → coller → Run.
--
-- - Chaque compte a un statut : en_attente, approuve ou suspendu.
--   Les apprenants qui s'inscrivent attendent l'approbation de l'administrateur ;
--   les encadreurs invités et l'administrateur sont approuvés d'office.
--   Un compte en attente ou suspendu n'a accès à rien (ni webinaires, ni bibliothèque).
-- - Chaque connexion à la plateforme est enregistrée (heure d'arrivée, dernier
--   signal toutes les minutes, heure de départ) pour calculer sa durée.

-- =====================================================================
-- Statut des comptes
-- =====================================================================

alter table public.profiles
  add column status text not null default 'approuve'
    check (status in ('en_attente', 'approuve', 'suspendu')),
  add column status_changed_at timestamptz,
  add column last_seen_at timestamptz;

-- Les comptes existants restent approuvés ; les nouveaux attendent l'approbation.
alter table public.profiles alter column status set default 'en_attente';

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'approuve' from public.profiles where id = auth.uid()), false)
$$;

-- Un compte non approuvé n'a plus de rôle : toutes les règles qui en dépendent le bloquent.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'approuve'
$$;

create or replace function public.owns_webinar(w uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and (
    public.my_role() = 'admin'
    or exists (select 1 from public.webinars where id = w and encadreur_id = auth.uid())
  )
$$;

create or replace function public.can_join(w uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and (
    public.owns_webinar(w)
    or exists (
      select 1 from public.registrations
       where webinar_id = w and apprenant_id = auth.uid() and not excluded
    )
  )
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv public.invitations;
begin
  select * into inv from public.invitations where email = lower(new.email);
  insert into public.profiles (id, email, full_name, role, status)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), inv.full_name, ''),
    coalesce(inv.role, 'apprenant'),
    case when inv.email is null then 'en_attente' else 'approuve' end
  );
  return new;
end $$;

create or replace function public.apply_invitation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  new.invited_by := auth.uid();
  update public.profiles
     set role = new.role,
         status = 'approuve',
         status_changed_at = now(),
         full_name = case when full_name = '' then new.full_name else full_name end
   where email = new.email;
  return new;
end $$;

-- =====================================================================
-- Historique des connexions à la plateforme
-- =====================================================================

create table public.app_sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  user_agent text not null default ''
);

create index app_sessions_user_idx on public.app_sessions (user_id, started_at desc);

alter table public.app_sessions enable row level security;

create policy "voir les connexions" on public.app_sessions for select to authenticated
  using (user_id = auth.uid() or public.my_role() = 'admin');
revoke insert, update, delete on public.app_sessions from anon, authenticated;

-- Les heures sont fixées par le serveur, jamais par le navigateur.
create or replace function public.session_start(agent text default '') returns bigint
language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Non connecté';
  end if;
  insert into public.app_sessions (user_id, user_agent)
  values (auth.uid(), left(coalesce(agent, ''), 200))
  returning id into new_id;
  update public.profiles set last_seen_at = now() where id = auth.uid();
  return new_id;
end $$;

-- Renvoie false si le compte n'est pas (ou plus) approuvé.
create or replace function public.session_ping(sid bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.app_sessions set last_seen_at = now()
   where id = sid and user_id = auth.uid() and ended_at is null;
  update public.profiles set last_seen_at = now() where id = auth.uid();
  return public.is_active();
end $$;

create or replace function public.session_end(sid bigint) returns void
language sql security definer set search_path = public as $$
  update public.app_sessions set ended_at = now(), last_seen_at = now()
   where id = sid and user_id = auth.uid() and ended_at is null
$$;

-- =====================================================================
-- Approbation et suspension (administrateur)
-- =====================================================================

create or replace function public.set_user_status(target uuid, new_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'Réservé à l''administrateur';
  end if;
  if target = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre compte';
  end if;
  if new_status not in ('en_attente', 'approuve', 'suspendu') then
    raise exception 'Statut inconnu';
  end if;
  update public.profiles set status = new_status, status_changed_at = now() where id = target;
  if new_status <> 'approuve' then
    update public.attendance set left_at = now() where user_id = target and left_at is null;
    update public.app_sessions set ended_at = now() where user_id = target and ended_at is null;
  end if;
end $$;

-- =====================================================================
-- Règles d'accès : un compte non approuvé ne voit plus rien
-- =====================================================================

drop policy "webinaires lisibles" on public.webinars;
create policy "webinaires lisibles" on public.webinars for select to authenticated
  using (public.is_active());

drop policy "lire la bibliothèque" on public.resources;
create policy "lire la bibliothèque" on public.resources for select to authenticated
  using (public.is_active());

drop policy "bibliothèque : lecture" on storage.objects;
create policy "bibliothèque : lecture" on storage.objects for select to authenticated
  using (bucket_id = 'bibliotheque' and public.is_active());

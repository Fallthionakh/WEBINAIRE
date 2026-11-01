-- WEBINAIRE – migration 003 : validation des inscriptions et ressources des webinaires
-- À exécuter une seule fois, après 002 : Supabase → SQL Editor → New query → coller → Run.
--
-- - Une inscription à un webinaire est « en attente » jusqu'à ce que l'encadreur
--   (ou l'administrateur) l'approuve ; il peut aussi la suspendre puis la réactiver.
--   Seules les inscriptions approuvées donnent accès à la salle.
-- - Une ressource de la bibliothèque peut être associée à plusieurs webinaires.

-- =====================================================================
-- Statut des inscriptions
-- =====================================================================

alter table public.registrations
  add column status text not null default 'en_attente'
    check (status in ('en_attente', 'approuve', 'suspendu')),
  add column status_changed_at timestamptz;

-- Les inscriptions existantes sont approuvées (ou suspendues si l'apprenant était exclu).
update public.registrations set status = case when excluded then 'suspendu' else 'approuve' end;

-- « excluded » reste synchronisé avec le statut (suspendu = exclu).
create or replace function public.registration_before_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    -- Un apprenant ne peut pas s'approuver lui-même.
    new.status := 'en_attente';
    new.excluded := false;
    new.excluded_at := null;
    new.status_changed_at := null;
    return new;
  end if;
  if new.status is distinct from old.status then
    new.excluded := new.status = 'suspendu';
  elsif new.excluded is distinct from old.excluded then
    new.status := case when new.excluded then 'suspendu' else 'approuve' end;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  new.excluded_at := case when new.excluded then coalesce(old.excluded_at, now()) end;
  return new;
end $$;

drop trigger registration_before_update on public.registrations;
drop function public.registration_before_update();

create trigger registration_before_write
  before insert or update on public.registrations
  for each row execute function public.registration_before_write();

-- Seules les inscriptions approuvées ouvrent la salle, le chat et la présence.
create or replace function public.can_join(w uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active() and (
    public.owns_webinar(w)
    or exists (
      select 1 from public.registrations
       where webinar_id = w and apprenant_id = auth.uid() and status = 'approuve'
    )
  )
$$;

-- =====================================================================
-- Ressources associées aux webinaires (plusieurs par webinaire et inversement)
-- =====================================================================

create table public.webinar_resources (
  webinar_id uuid not null references public.webinars on delete cascade,
  resource_id uuid not null references public.resources on delete cascade,
  added_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  primary key (webinar_id, resource_id)
);

create index webinar_resources_resource_idx on public.webinar_resources (resource_id);

-- Reprise des liens existants.
insert into public.webinar_resources (webinar_id, resource_id, added_by)
select webinar_id, id, owner_id from public.resources where webinar_id is not null
on conflict do nothing;

alter table public.webinar_resources enable row level security;

create policy "voir les ressources des webinaires" on public.webinar_resources for select to authenticated
  using (public.is_active());
-- L'encadreur du webinaire (ou l'admin) y associe n'importe quelle ressource de la bibliothèque.
create policy "associer une ressource" on public.webinar_resources for insert to authenticated
  with check (public.owns_webinar(webinar_id));
create policy "retirer une ressource" on public.webinar_resources for delete to authenticated
  using (public.owns_webinar(webinar_id));

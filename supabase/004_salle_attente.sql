-- WEBINAIRE – migration 004 : salle d'attente (comme sur Zoom)
-- À exécuter une seule fois, après 003 : Supabase → SQL Editor → New query → coller → Run.
--
-- - Toute personne connectée qui ouvre le lien d'un webinaire « frappe à la porte » :
--   elle arrive dans la salle d'attente, et l'organisateur l'admet ou la refuse.
-- - À chaque nouvelle entrée (retour après avoir quitté, rechargement, exclusion),
--   la personne repasse par la salle d'attente.
-- - Un compte encore « en attente » de validation par l'admin peut entrer par un lien
--   si l'organisateur l'admet ; un compte suspendu ne peut pas.

create table public.lobby (
  webinar_id uuid not null references public.webinars on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  status text not null default 'en_attente' check (status in ('en_attente', 'admis', 'refuse', 'exclu')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (webinar_id, user_id)
);

alter table public.lobby enable row level security;

create policy "voir la salle d'attente" on public.lobby for select to authenticated
  using (user_id = auth.uid() or public.owns_webinar(webinar_id));
revoke insert, update, delete on public.lobby from anon, authenticated;

-- Entrer dans la salle d'attente (ou y revenir).
create or replace function public.lobby_knock(w uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  st text;
  reg text;
begin
  if auth.uid() is null then
    raise exception 'Non connecté';
  end if;
  if (select status from public.profiles where id = auth.uid()) = 'suspendu' then
    raise exception 'Votre compte est suspendu';
  end if;
  select status into st from public.webinars where id = w;
  if st is null then
    raise exception 'Webinaire introuvable';
  end if;
  if public.owns_webinar(w) then
    return 'admis';
  end if;
  if st in ('termine', 'annule') then
    raise exception 'Ce webinaire n''est pas ouvert';
  end if;
  select status into reg from public.registrations where webinar_id = w and apprenant_id = auth.uid();
  if reg = 'suspendu' then
    raise exception 'Votre inscription à ce webinaire est suspendue';
  end if;
  insert into public.lobby (webinar_id, user_id, status, requested_at, decided_at)
  values (w, auth.uid(), 'en_attente', now(), null)
  on conflict (webinar_id, user_id)
  do update set status = 'en_attente', requested_at = now(), decided_at = null;
  return 'en_attente';
end $$;

-- L'organisateur admet, refuse ou exclut une personne.
create or replace function public.lobby_decide(w uuid, target uuid, decision text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_webinar(w) then
    raise exception 'Réservé à l''organisateur du webinaire';
  end if;
  if decision not in ('admis', 'refuse', 'exclu') then
    raise exception 'Décision inconnue';
  end if;
  update public.lobby set status = decision, decided_at = now()
   where webinar_id = w and user_id = target;
  if not found then
    raise exception 'Cette personne n''est plus dans la salle d''attente';
  end if;
  if decision = 'admis' then
    -- Une personne admise devient inscrite (approuvée) : elle figure dans la liste de présence.
    insert into public.registrations (webinar_id, apprenant_id) values (w, target) on conflict do nothing;
    update public.registrations set status = 'approuve'
     where webinar_id = w and apprenant_id = target and status <> 'approuve';
  else
    update public.attendance set left_at = now()
     where webinar_id = w and user_id = target and left_at is null;
  end if;
end $$;

-- Quitter la salle : il faudra repasser par la salle d'attente pour revenir.
create or replace function public.lobby_leave(w uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.lobby where webinar_id = w and user_id = auth.uid()
$$;

-- Accès à la salle (visio, chat, présence) : organisateur, ou personne admise.
create or replace function public.can_join(w uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status <> 'suspendu' from public.profiles where id = auth.uid()), false) and (
    public.owns_webinar(w)
    or exists (
      select 1 from public.lobby
       where webinar_id = w and user_id = auth.uid() and status = 'admis'
    )
  )
$$;

-- Une personne arrivée par un lien voit le webinaire qu'elle a demandé à rejoindre.
drop policy "webinaires lisibles" on public.webinars;
create policy "webinaires lisibles" on public.webinars for select to authenticated
  using (
    public.is_active()
    or exists (select 1 from public.lobby l where l.webinar_id = id and l.user_id = auth.uid())
  );

alter publication supabase_realtime add table public.lobby;

-- WEBINAIRE – migration 006 : retour automatique dans la salle et heure de début du direct
-- À exécuter une seule fois, après 005 : Supabase → SQL Editor → New query → coller → Run.
--
-- - Un participant admis qui quitte la salle (ou recharge la page) y revient
--   directement, sans repasser par la salle d'attente. Chaque entrée et chaque
--   sortie restent enregistrées dans la liste de présence.
-- - Un participant retiré ou refusé par l'organisateur repasse, lui, par la
--   salle d'attente.
-- - L'heure de début du direct est enregistrée, pour afficher le temps écoulé.

-- Nouveau statut « parti » : admis puis sorti de lui-même.
alter table public.lobby drop constraint lobby_status_check;
alter table public.lobby add constraint lobby_status_check
  check (status in ('en_attente', 'admis', 'refuse', 'exclu', 'parti'));

create or replace function public.lobby_knock(w uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  st text;
  reg text;
  prev text;
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

  -- Déjà admis pendant ce cours : retour direct dans la salle.
  select status into prev from public.lobby where webinar_id = w and user_id = auth.uid();
  if prev in ('admis', 'parti') then
    update public.lobby set status = 'admis', requested_at = now(), decided_at = now()
     where webinar_id = w and user_id = auth.uid();
    return 'admis';
  end if;

  insert into public.lobby (webinar_id, user_id, status, requested_at, decided_at)
  values (w, auth.uid(), 'en_attente', now(), null)
  on conflict (webinar_id, user_id)
  do update set status = 'en_attente', requested_at = now(), decided_at = null;
  return 'en_attente';
end $$;

-- Quitter : un participant admis devient « parti » (il pourra revenir directement) ;
-- une personne qui attendait encore est retirée de la salle d'attente.
create or replace function public.lobby_leave(w uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.lobby set status = 'parti', decided_at = now()
   where webinar_id = w and user_id = auth.uid() and status = 'admis';
  delete from public.lobby
   where webinar_id = w and user_id = auth.uid() and status = 'en_attente';
end $$;

-- Heure de début du direct (à chaque lancement ou réouverture).
alter table public.webinars add column live_started_at timestamptz;

create or replace function public.webinar_before_write() returns trigger
language plpgsql as $$
begin
  new.ends_at := new.starts_at + make_interval(mins => new.duration_minutes);
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.starts_at is distinct from old.starts_at then
    new.rescheduled_at := now();
  end if;
  if new.status = 'en_direct' and (tg_op = 'INSERT' or old.status is distinct from 'en_direct') then
    new.live_started_at := now();
  end if;
  return new;
end $$;

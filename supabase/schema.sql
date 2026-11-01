-- WEBINAIRE – schéma de la base de données Supabase
-- À exécuter une seule fois : Supabase → SQL Editor → New query → coller → Run.
--
-- Rôles : admin (gère les encadreurs), encadreur (crée les webinaires et la
-- bibliothèque), apprenant (s'inscrit aux webinaires). Toute la sécurité est
-- assurée par les règles RLS ci-dessous : la clé publique du site ne permet
-- rien d'autre que ce qu'elles autorisent.

-- =====================================================================
-- Profils, rôles et invitations
-- =====================================================================

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'apprenant' check (role in ('admin', 'encadreur', 'apprenant')),
  created_at timestamptz not null default now()
);

-- L'admin « donne accès » à un encadreur en l'invitant par e-mail :
-- à son inscription (ou tout de suite s'il a déjà un compte), il reçoit le rôle.
create table public.invitations (
  email text primary key,
  role text not null check (role in ('admin', 'encadreur')),
  full_name text not null default '',
  invited_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv public.invitations;
begin
  select * into inv from public.invitations where email = lower(new.email);
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), inv.full_name, ''),
    coalesce(inv.role, 'apprenant')
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.apply_invitation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  new.invited_by := auth.uid();
  update public.profiles
     set role = new.role,
         full_name = case when full_name = '' then new.full_name else full_name end
   where email = new.email;
  return new;
end $$;

create trigger on_invitation_created
  before insert on public.invitations
  for each row execute function public.apply_invitation();

-- Changement de rôle (ex. retirer l'accès d'un encadreur) : admin uniquement.
create or replace function public.set_user_role(target uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'Réservé à l''administrateur';
  end if;
  if target = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle';
  end if;
  if new_role not in ('admin', 'encadreur', 'apprenant') then
    raise exception 'Rôle inconnu';
  end if;
  update public.profiles set role = new_role where id = target;
  if new_role = 'apprenant' then
    delete from public.invitations where email = (select email from public.profiles where id = target);
  end if;
end $$;

-- =====================================================================
-- Webinaires et inscriptions
-- =====================================================================

create table public.webinars (
  id uuid primary key default gen_random_uuid(),
  encadreur_id uuid not null references public.profiles on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  starts_at timestamptz not null,
  duration_minutes int not null check (duration_minutes between 5 and 720),
  ends_at timestamptz not null,
  status text not null default 'planifie'
    check (status in ('planifie', 'en_direct', 'termine', 'annule')),
  cancel_reason text,
  rescheduled_at timestamptz,
  stage jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Heure de fin calculée, date de reprogrammation, fermeture des présences.
create or replace function public.webinar_before_write() returns trigger
language plpgsql as $$
begin
  new.ends_at := new.starts_at + make_interval(mins => new.duration_minutes);
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.starts_at is distinct from old.starts_at then
    new.rescheduled_at := now();
  end if;
  return new;
end $$;

create trigger webinar_before_write
  before insert or update on public.webinars
  for each row execute function public.webinar_before_write();

create table public.registrations (
  webinar_id uuid not null references public.webinars on delete cascade,
  apprenant_id uuid not null references public.profiles on delete cascade,
  registered_at timestamptz not null default now(),
  excluded boolean not null default false,
  excluded_at timestamptz,
  primary key (webinar_id, apprenant_id)
);

create or replace function public.owns_webinar(w uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() = 'admin'
      or exists (select 1 from public.webinars where id = w and encadreur_id = auth.uid())
$$;

create or replace function public.can_join(w uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.owns_webinar(w)
      or exists (
        select 1 from public.registrations
         where webinar_id = w and apprenant_id = auth.uid() and not excluded
      )
$$;

-- =====================================================================
-- Liste de présence automatique
-- =====================================================================

-- Une ligne par connexion : heure d'arrivée, dernier signal (toutes les
-- 30 s), heure de départ. Durée = (départ ou dernier signal) – arrivée.
create table public.attendance (
  id bigint generated always as identity primary key,
  webinar_id uuid not null references public.webinars on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz
);

create index attendance_webinar_idx on public.attendance (webinar_id);

-- Les heures sont fixées par le serveur, jamais par le navigateur.
create or replace function public.attendance_join(w uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  st text;
  new_id bigint;
begin
  select status into st from public.webinars where id = w;
  if not public.can_join(w) then
    raise exception 'Accès refusé';
  end if;
  if st is distinct from 'en_direct' and not public.owns_webinar(w) then
    raise exception 'Le webinaire n''est pas en direct';
  end if;
  insert into public.attendance (webinar_id, user_id) values (w, auth.uid())
  returning id into new_id;
  return new_id;
end $$;

-- Renvoie false si la personne n'a plus le droit d'être là (exclue, direct terminé).
create or replace function public.attendance_ping(session_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  w uuid;
begin
  update public.attendance
     set last_seen_at = now()
   where id = session_id and user_id = auth.uid() and left_at is null
  returning webinar_id into w;
  return w is not null and public.can_join(w);
end $$;

create or replace function public.attendance_leave(session_id bigint) returns void
language sql security definer set search_path = public as $$
  update public.attendance
     set left_at = now(), last_seen_at = now()
   where id = session_id and user_id = auth.uid() and left_at is null
$$;

-- Exclusion : ferme immédiatement les connexions ouvertes de l'apprenant.
create or replace function public.registration_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.excluded and not old.excluded then
    update public.attendance set left_at = now()
     where webinar_id = new.webinar_id and user_id = new.apprenant_id and left_at is null;
  end if;
  return new;
end $$;

create trigger registration_after_update
  after update on public.registrations
  for each row execute function public.registration_after_update();

create or replace function public.registration_before_update() returns trigger
language plpgsql as $$
begin
  new.excluded_at := case when new.excluded then coalesce(old.excluded_at, now()) end;
  return new;
end $$;

create trigger registration_before_update
  before update on public.registrations
  for each row execute function public.registration_before_update();

-- Fin du direct : ferme toutes les connexions encore ouvertes.
create or replace function public.webinar_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('termine', 'annule') and old.status = 'en_direct' then
    update public.attendance set left_at = coalesce(left_at, last_seen_at)
     where webinar_id = new.id and left_at is null;
  end if;
  return new;
end $$;

create trigger webinar_after_update
  after update on public.webinars
  for each row execute function public.webinar_after_update();

-- =====================================================================
-- Interaction : chat, questions, sondages
-- =====================================================================

create table public.messages (
  id bigint generated always as identity primary key,
  webinar_id uuid not null references public.webinars on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  author_name text not null default '',
  kind text not null default 'chat' check (kind in ('chat', 'question')),
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index messages_webinar_idx on public.messages (webinar_id);

create or replace function public.message_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.author_name := (select full_name from public.profiles where id = auth.uid());
  new.created_at := now();
  return new;
end $$;

create trigger message_before_insert
  before insert on public.messages
  for each row execute function public.message_before_insert();

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  webinar_id uuid not null references public.webinars on delete cascade,
  question text not null,
  options text[] not null check (cardinality(options) between 2 and 10),
  created_at timestamptz not null default now()
);

create table public.poll_votes (
  poll_id uuid not null references public.polls on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  option_index int not null check (option_index >= 0),
  primary key (poll_id, user_id)
);

-- =====================================================================
-- Bibliothèque de ressources
-- =====================================================================

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  file_path text not null unique,
  file_name text not null,
  mime_type text not null default '',
  size_bytes bigint not null default 0,
  webinar_id uuid references public.webinars on delete set null,
  created_at timestamptz not null default now()
);

-- 50 Mo par fichier : maximum de l'offre gratuite de Supabase.
insert into storage.buckets (id, name, public, file_size_limit)
values ('bibliotheque', 'bibliotheque', false, 52428800)
on conflict (id) do nothing;

-- =====================================================================
-- Sécurité (Row Level Security)
-- =====================================================================

alter table public.profiles      enable row level security;
alter table public.invitations   enable row level security;
alter table public.webinars      enable row level security;
alter table public.registrations enable row level security;
alter table public.attendance    enable row level security;
alter table public.messages      enable row level security;
alter table public.polls         enable row level security;
alter table public.poll_votes    enable row level security;
alter table public.resources     enable row level security;

-- Profils : chacun voit le sien, tout le monde voit les encadreurs,
-- l'admin et les encadreurs voient tout le monde.
create policy "profils lisibles" on public.profiles for select to authenticated
  using (id = auth.uid() or role in ('admin', 'encadreur') or public.my_role() in ('admin', 'encadreur'));
create policy "modifier son profil" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Seul le nom est modifiable directement (le rôle passe par set_user_role).
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy "invitations admin" on public.invitations for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

create policy "webinaires lisibles" on public.webinars for select to authenticated
  using (true);
create policy "créer un webinaire" on public.webinars for insert to authenticated
  with check (public.my_role() in ('admin', 'encadreur') and encadreur_id = auth.uid());
create policy "gérer son webinaire" on public.webinars for update to authenticated
  using (public.owns_webinar(id)) with check (public.owns_webinar(id));
create policy "supprimer son webinaire" on public.webinars for delete to authenticated
  using (public.owns_webinar(id));

create policy "voir les inscriptions" on public.registrations for select to authenticated
  using (apprenant_id = auth.uid() or public.owns_webinar(webinar_id));
create policy "s'inscrire" on public.registrations for insert to authenticated
  with check (
    apprenant_id = auth.uid()
    and not excluded
    and public.my_role() = 'apprenant'
    and exists (select 1 from public.webinars w
                 where w.id = webinar_id and w.status in ('planifie', 'en_direct'))
  );
create policy "se désinscrire" on public.registrations for delete to authenticated
  using (apprenant_id = auth.uid() and not excluded);
create policy "exclure ou réintégrer" on public.registrations for update to authenticated
  using (public.owns_webinar(webinar_id)) with check (public.owns_webinar(webinar_id));

create policy "voir les présences" on public.attendance for select to authenticated
  using (user_id = auth.uid() or public.owns_webinar(webinar_id));
revoke insert, update, delete on public.attendance from anon, authenticated;

create policy "lire le chat" on public.messages for select to authenticated
  using (public.can_join(webinar_id));
create policy "écrire dans le chat" on public.messages for insert to authenticated
  with check (public.can_join(webinar_id));
create policy "modérer le chat" on public.messages for delete to authenticated
  using (public.owns_webinar(webinar_id));

create policy "lire les sondages" on public.polls for select to authenticated
  using (public.can_join(webinar_id));
create policy "créer un sondage" on public.polls for insert to authenticated
  with check (public.owns_webinar(webinar_id));
create policy "supprimer un sondage" on public.polls for delete to authenticated
  using (public.owns_webinar(webinar_id));

create policy "lire les votes" on public.poll_votes for select to authenticated
  using (exists (select 1 from public.polls p where p.id = poll_id and public.can_join(p.webinar_id)));
create policy "voter" on public.poll_votes for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.polls p
                 where p.id = poll_id and public.can_join(p.webinar_id)
                   and option_index < cardinality(p.options))
  );

create policy "lire la bibliothèque" on public.resources for select to authenticated
  using (true);
create policy "déposer une ressource" on public.resources for insert to authenticated
  with check (public.my_role() in ('admin', 'encadreur') and owner_id = auth.uid());
create policy "modifier sa ressource" on public.resources for update to authenticated
  using (owner_id = auth.uid() or public.my_role() = 'admin');
create policy "supprimer sa ressource" on public.resources for delete to authenticated
  using (owner_id = auth.uid() or public.my_role() = 'admin');

create policy "bibliothèque : lecture" on storage.objects for select to authenticated
  using (bucket_id = 'bibliotheque');
create policy "bibliothèque : dépôt" on storage.objects for insert to authenticated
  with check (bucket_id = 'bibliotheque' and public.my_role() in ('admin', 'encadreur'));
create policy "bibliothèque : suppression" on storage.objects for delete to authenticated
  using (bucket_id = 'bibliotheque' and (owner_id = auth.uid()::text or public.my_role() = 'admin'));

-- =====================================================================
-- Temps réel
-- =====================================================================

alter publication supabase_realtime add table
  public.webinars, public.registrations, public.attendance,
  public.messages, public.polls, public.poll_votes;

-- =====================================================================
-- Compte administrateur
-- =====================================================================

-- Le compte est créé dans Supabase (Authentication → Add user) avec un mot
-- de passe choisi à ce moment-là : il n'apparaît jamais dans le code.
insert into public.invitations (email, role, full_name)
values ('wommatsn@gmail.com', 'admin', 'Administrateur WOMMAT')
on conflict (email) do nothing;

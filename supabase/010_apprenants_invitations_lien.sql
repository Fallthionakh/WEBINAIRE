-- WEBINAIRE – migration 010 : apprenants, invitations et lien d'entrée directe
-- À exécuter une seule fois, après 009 : Supabase → SQL Editor → New query → coller → Run.
--
-- AVANT : activez les connexions invitées dans Supabase :
--   Authentication → Sign In / Providers → « Allow anonymous sign-ins » → Save.
--
-- 1. Fiches apprenants : nom, prénom, filière, année, téléphone, e-mail, adresse.
-- 2. Invitations : à la création d'un webinaire, on choisit les apprenants
--    invités. Un apprenant qui a déjà un compte est inscrit et admis d'office.
--    L'animateur (encadreur) est ajouté d'office : l'administrateur peut le choisir.
-- 3. Lien unique par webinaire : au clic, la personne donne seulement son nom
--    (si elle n'est pas connectée) et entre directement dans la salle, sans
--    e-mail, sans mot de passe et sans salle d'attente.

-- =====================================================================
-- 1. Fiches apprenants
-- =====================================================================

create table if not exists public.apprenants (
  id uuid primary key default gen_random_uuid(),
  nom text not null check (char_length(trim(nom)) between 1 and 80),
  prenom text not null check (char_length(trim(prenom)) between 1 and 80),
  filiere text not null default '' check (char_length(filiere) <= 120),
  annee text not null default '' check (char_length(annee) <= 40),
  telephone text not null default '' check (char_length(telephone) <= 40),
  email text not null default '' check (email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  adresse text not null default '' check (char_length(adresse) <= 300),
  profile_id uuid references public.profiles on delete set null, -- compte relié (même e-mail)
  created_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists apprenants_email_key on public.apprenants (lower(email)) where email <> '';
create index if not exists apprenants_filiere on public.apprenants (filiere, annee);

create or replace function public.apprenant_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  new.nom := trim(new.nom);
  new.prenom := trim(new.prenom);
  new.filiere := trim(new.filiere);
  new.annee := trim(new.annee);
  new.telephone := trim(new.telephone);
  new.adresse := trim(new.adresse);
  new.updated_at := now();
  new.profile_id := case when new.email = '' then null
                         else (select id from public.profiles where email = new.email) end;
  return new;
end $$;

drop trigger if exists apprenant_before_write on public.apprenants;
create trigger apprenant_before_write
  before insert or update on public.apprenants
  for each row execute function public.apprenant_before_write();

alter table public.apprenants enable row level security;
-- Administrateur : tout ; encadreurs : lecture (pour inviter des apprenants).
drop policy if exists "apprenants lecture" on public.apprenants;
create policy "apprenants lecture" on public.apprenants for select to authenticated
  using (public.my_role() in ('admin', 'encadreur'));
drop policy if exists "apprenants admin" on public.apprenants;
create policy "apprenants admin" on public.apprenants for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- =====================================================================
-- 2. Invitations aux webinaires
-- =====================================================================

create table if not exists public.webinar_invites (
  webinar_id uuid not null references public.webinars on delete cascade,
  apprenant_id uuid not null references public.apprenants on delete cascade,
  invited_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  primary key (webinar_id, apprenant_id)
);

alter table public.webinar_invites enable row level security;
drop policy if exists "invitations webinaire" on public.webinar_invites;
create policy "invitations webinaire" on public.webinar_invites for all to authenticated
  using (public.owns_webinar(webinar_id)) with check (public.owns_webinar(webinar_id));

-- Inscrit et admet d'office un compte à un webinaire (ni salle d'attente, ni validation).
create or replace function public.admit_to_webinar(w uuid, uid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.registrations (webinar_id, apprenant_id) values (w, uid)
  on conflict (webinar_id, apprenant_id) do nothing;
  update public.registrations set status = 'approuve'
   where webinar_id = w and apprenant_id = uid and status = 'en_attente';
  insert into public.lobby (webinar_id, user_id, status, requested_at, decided_at)
  values (w, uid, 'admis', now(), now())
  on conflict (webinar_id, user_id) do update
    set status = 'admis', decided_at = now()
    where public.lobby.status in ('en_attente', 'parti');
end $$;
revoke execute on function public.admit_to_webinar(uuid, uuid) from public, anon, authenticated;

-- Invité qui a déjà un compte (même e-mail) : inscrit et admis tout de suite.
create or replace function public.webinar_invite_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
begin
  select profile_id into uid from public.apprenants where id = new.apprenant_id;
  if uid is not null then
    perform public.admit_to_webinar(new.webinar_id, uid);
  end if;
  return new;
end $$;

drop trigger if exists webinar_invite_after_insert on public.webinar_invites;
create trigger webinar_invite_after_insert
  after insert on public.webinar_invites
  for each row execute function public.webinar_invite_after_insert();

-- Un compte créé après coup est relié à sa fiche (encadreur ou apprenant)
-- et admis aux webinaires auxquels il était invité.
create or replace function public.link_encadreur_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv record;
begin
  if coalesce(new.email, '') = '' then
    return new;
  end if;
  update public.encadreurs set profile_id = new.id where lower(email) = lower(new.email);
  update public.apprenants set profile_id = new.id where email = lower(new.email);
  -- Apprenant déjà enregistré par l'administrateur : son compte est validé d'office.
  if exists (select 1 from public.apprenants where email = lower(new.email)) then
    update public.profiles set status = 'approuve', status_changed_at = now()
     where id = new.id and status = 'en_attente';
  end if;
  for inv in
    select wi.webinar_id from public.webinar_invites wi
      join public.apprenants a on a.id = wi.apprenant_id
      join public.webinars wb on wb.id = wi.webinar_id
     where a.email = lower(new.email) and wb.status in ('planifie', 'en_direct')
  loop
    perform public.admit_to_webinar(inv.webinar_id, new.id);
  end loop;
  return new;
end $$;

-- L'animateur peut être choisi par l'administrateur (un encadreur ou un administrateur).
drop policy if exists "créer un webinaire" on public.webinars;
create policy "créer un webinaire" on public.webinars for insert to authenticated
  with check (
    public.my_role() in ('admin', 'encadreur')
    and (
      encadreur_id = auth.uid()
      or (public.my_role() = 'admin'
          and exists (select 1 from public.profiles p
                       where p.id = encadreur_id and p.role in ('admin', 'encadreur') and p.status = 'approuve'))
    )
  );

-- =====================================================================
-- 3. Lien unique d'entrée directe
-- =====================================================================

-- Le code est rangé à part : seul l'organisateur (ou l'admin) peut le lire.
create table if not exists public.webinar_links (
  webinar_id uuid primary key references public.webinars on delete cascade,
  code text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
  created_at timestamptz not null default now()
);
insert into public.webinar_links (webinar_id) select id from public.webinars on conflict do nothing;

create or replace function public.webinar_link_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.webinar_links (webinar_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists webinar_link_after_insert on public.webinars;
create trigger webinar_link_after_insert
  after insert on public.webinars
  for each row execute function public.webinar_link_after_insert();

alter table public.webinar_links enable row level security;
drop policy if exists "lien du webinaire" on public.webinar_links;
create policy "lien du webinaire" on public.webinar_links for select to authenticated
  using (public.owns_webinar(webinar_id));
revoke insert, update, delete on public.webinar_links from anon, authenticated;

-- Nouveau lien (si l'ancien a trop circulé) : l'ancien ne marche plus.
create or replace function public.renew_webinar_link(w uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  c text;
begin
  if not public.owns_webinar(w) then
    raise exception 'Réservé à l''organisateur';
  end if;
  update public.webinar_links set code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), created_at = now()
   where webinar_id = w returning code into c;
  return c;
end $$;

-- Aperçu avant d'entrer (visible sans être connecté) : titre, date, animateur.
create or replace function public.webinar_by_code(c text) returns table (
  id uuid, title text, starts_at timestamptz, ends_at timestamptz, status text, animateur text
)
language sql stable security definer set search_path = public as $$
  select w.id, w.title, w.starts_at, w.ends_at, w.status, coalesce(p.full_name, '')
    from public.webinar_links l
    join public.webinars w on w.id = l.webinar_id
    left join public.profiles p on p.id = w.encadreur_id
   where l.code = c
$$;
grant execute on function public.webinar_by_code(text) to anon, authenticated;

-- Entrer par le lien : inscrit et admis d'office, sans salle d'attente.
create or replace function public.join_by_code(c text, display_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  w public.webinars;
  me public.profiles;
  lob text;
begin
  if auth.uid() is null then
    raise exception 'Non connecté';
  end if;
  select wb.* into w from public.webinar_links l join public.webinars wb on wb.id = l.webinar_id where l.code = c;
  if w.id is null then
    raise exception 'Lien invalide ou expiré';
  end if;
  select * into me from public.profiles where id = auth.uid();
  if me.status = 'suspendu' then
    raise exception 'Votre compte est suspendu';
  end if;
  if nullif(trim(coalesce(display_name, '')), '') is not null and coalesce(me.full_name, '') = '' then
    update public.profiles set full_name = left(trim(display_name), 120) where id = auth.uid();
  end if;
  if public.owns_webinar(w.id) then
    return w.id;
  end if;
  if w.status in ('termine', 'annule') then
    raise exception 'Ce webinaire est %', case w.status when 'termine' then 'terminé' else 'annulé' end;
  end if;
  select status into lob from public.lobby where webinar_id = w.id and user_id = auth.uid();
  if lob = 'exclu' or exists (select 1 from public.registrations
                               where webinar_id = w.id and apprenant_id = auth.uid() and status = 'suspendu') then
    raise exception 'L''organisateur vous a retiré de ce webinaire';
  end if;
  perform public.admit_to_webinar(w.id, auth.uid());
  return w.id;
end $$;
grant execute on function public.join_by_code(text, text) to authenticated;

-- Comptes invités (connexion anonyme par le lien) : approuvés d'office, sans e-mail.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv public.invitations;
begin
  if coalesce(new.is_anonymous, false) then
    insert into public.profiles (id, email, full_name, role, status)
    values (new.id, '', left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Invité'), 120),
            'apprenant', 'approuve');
    return new;
  end if;
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

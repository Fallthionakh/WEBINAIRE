-- WEBINAIRE – migration 009 : rubrique « Encadreurs »
-- À exécuter une seule fois, après 008 : Supabase → SQL Editor → New query → coller → Run.
--
-- L'administrateur tient une fiche par encadreur : nom, prénom, téléphone,
-- e-mail et documents (CV, diplômes, attestations…), consultables en ligne.
-- Si « accès à la plateforme » est coché, l'e-mail reçoit automatiquement le
-- rôle encadreur (même mécanisme que les invitations) : à son inscription,
-- ou tout de suite s'il a déjà un compte. La fiche est alors reliée au compte.
-- Fiches, documents et fichiers sont réservés à l'administrateur.

create table if not exists public.encadreurs (
  id uuid primary key default gen_random_uuid(),
  nom text not null check (char_length(trim(nom)) between 1 and 80),
  prenom text not null check (char_length(trim(prenom)) between 1 and 80),
  telephone text not null default '' check (char_length(telephone) <= 40),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  acces boolean not null default true,      -- donne le rôle encadreur sur la plateforme
  notes text not null default '' check (char_length(notes) <= 2000),
  profile_id uuid references public.profiles on delete set null, -- compte relié (même e-mail)
  created_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists encadreurs_email_key on public.encadreurs (lower(email));

create table if not exists public.encadreur_documents (
  id uuid primary key default gen_random_uuid(),
  encadreur_id uuid not null references public.encadreurs on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  file_path text not null unique,
  file_name text not null,
  mime_type text not null default '',
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists encadreur_documents_encadreur on public.encadreur_documents (encadreur_id);

-- E-mail normalisé, date de mise à jour, compte relié et rôle encadreur.
create or replace function public.encadreur_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  existing public.profiles;
begin
  new.email := lower(trim(new.email));
  new.nom := trim(new.nom);
  new.prenom := trim(new.prenom);
  new.telephone := trim(new.telephone);
  new.updated_at := now();
  select * into existing from public.profiles where email = new.email;
  new.profile_id := existing.id;
  -- Accès à la plateforme : invitation « encadreur », sauf pour un administrateur
  -- (on ne retire jamais le rôle admin par ce biais).
  if new.acces and (existing.id is null or existing.role <> 'admin') then
    insert into public.invitations (email, role, full_name)
    values (new.email, 'encadreur', new.prenom || ' ' || new.nom)
    on conflict (email) do update set role = 'encadreur', full_name = excluded.full_name;
    update public.profiles
       set role = 'encadreur',
           full_name = case when full_name = '' then new.prenom || ' ' || new.nom else full_name end
     where email = new.email and role <> 'admin';
    -- Si la colonne de validation des comptes existe (migration 002), le compte est approuvé.
    begin
      execute 'update public.profiles set status = ''approuve'' where email = $1 and role <> ''admin'''
        using new.email;
    exception when undefined_column then null;
    end;
  end if;
  return new;
end $$;

drop trigger if exists encadreur_before_write on public.encadreurs;
create trigger encadreur_before_write
  before insert or update on public.encadreurs
  for each row execute function public.encadreur_before_write();

-- Un encadreur qui crée son compte après coup est relié à sa fiche.
create or replace function public.link_encadreur_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.encadreurs set profile_id = new.id where lower(email) = lower(new.email);
  return new;
end $$;

drop trigger if exists link_encadreur_profile on public.profiles;
create trigger link_encadreur_profile
  after insert on public.profiles
  for each row execute function public.link_encadreur_profile();

-- Sécurité : réservé à l'administrateur.
alter table public.encadreurs enable row level security;
alter table public.encadreur_documents enable row level security;

drop policy if exists "encadreurs admin" on public.encadreurs;
create policy "encadreurs admin" on public.encadreurs for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

drop policy if exists "encadreur documents admin" on public.encadreur_documents;
create policy "encadreur documents admin" on public.encadreur_documents for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- Fichiers : dossier privé « encadreurs » (50 Mo par fichier).
insert into storage.buckets (id, name, public, file_size_limit)
values ('encadreurs', 'encadreurs', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "encadreurs fichiers admin" on storage.objects;
create policy "encadreurs fichiers admin" on storage.objects for all to authenticated
  using (bucket_id = 'encadreurs' and public.my_role() = 'admin')
  with check (bucket_id = 'encadreurs' and public.my_role() = 'admin');

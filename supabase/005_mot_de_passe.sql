-- WEBINAIRE – migration 005 : aide en cas de mot de passe oublié
-- À exécuter une seule fois, après 004 : Supabase → SQL Editor → New query → coller → Run.
--
-- L'envoi d'e-mails par défaut de Supabase est très limité. Pour ne bloquer
-- personne, un utilisateur qui a oublié son mot de passe peut aussi « demander
-- de l'aide » : l'administrateur voit la demande et génère un mot de passe
-- provisoire (fonction admin-reset-password), que l'utilisateur devra changer
-- à sa prochaine connexion.

create table public.password_requests (
  id bigint generated always as identity primary key,
  email text not null,
  user_id uuid not null references public.profiles on delete cascade,
  status text not null default 'en_attente' check (status in ('en_attente', 'traitee', 'annulee')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references public.profiles on delete set null
);

alter table public.password_requests enable row level security;

create policy "demandes de mot de passe : admin" on public.password_requests for select to authenticated
  using (public.my_role() = 'admin');
create policy "traiter une demande : admin" on public.password_requests for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
revoke insert, delete on public.password_requests from anon, authenticated;

-- Appelable sans être connecté. Ne dit jamais si l'e-mail existe (pas d'énumération
-- des comptes) et ignore les demandes répétées pour le même e-mail pendant 10 minutes.
create or replace function public.request_password_help(p_email text) returns void
language sql security definer set search_path = public as $$
  insert into public.password_requests (email, user_id)
  select p.email, p.id
    from public.profiles p
   where p.email = lower(trim(p_email))
     and not exists (
       select 1 from public.password_requests r
        where r.user_id = p.id and r.status = 'en_attente'
          and r.created_at > now() - interval '10 minutes'
     )
$$;

grant execute on function public.request_password_help(text) to anon, authenticated;

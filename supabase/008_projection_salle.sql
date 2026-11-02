-- WEBINAIRE – migration 008 : projection depuis le téléphone
-- À exécuter une seule fois, après 007 : Supabase → SQL Editor → New query → coller → Run.
--
-- Les navigateurs de téléphone et de tablette ne permettent pas le partage
-- d'écran. Un participant peut donc montrer à toute la salle une capture
-- d'écran, une photo ou un PDF. Les fichiers sont rangés dans le dossier privé
-- « salle », sous le chemin <webinaire>/<auteur>/<fichier> :
--   - dépôt : seulement dans son propre dossier, pour un webinaire où l'on a accès ;
--   - lecture : toute personne ayant accès au webinaire ;
--   - suppression : l'auteur, ou l'organisateur du webinaire.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('salle', 'salle', false, 20971520,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Identifiant du webinaire contenu dans le chemin (null si le chemin est invalide).
create or replace function public.salle_webinar(path text) returns uuid
language sql immutable as $$
  select case
           when split_part(path, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then split_part(path, '/', 1)::uuid
         end
$$;

drop policy if exists "salle : dépôt" on storage.objects;
create policy "salle : dépôt" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'salle'
    and split_part(name, '/', 2) = auth.uid()::text
    and public.can_join(public.salle_webinar(name))
  );

drop policy if exists "salle : lecture" on storage.objects;
create policy "salle : lecture" on storage.objects for select to authenticated
  using (bucket_id = 'salle' and public.can_join(public.salle_webinar(name)));

drop policy if exists "salle : suppression" on storage.objects;
create policy "salle : suppression" on storage.objects for delete to authenticated
  using (
    bucket_id = 'salle'
    and (
      split_part(name, '/', 2) = auth.uid()::text
      or public.owns_webinar(public.salle_webinar(name))
    )
  );

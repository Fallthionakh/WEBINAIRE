-- WEBINAIRE – migration 007 : ressources visibles seulement par les inscrits
-- À exécuter une seule fois, après 006 : Supabase → SQL Editor → New query → coller → Run.
--
-- - Encadreurs et administrateurs voient toute la bibliothèque.
-- - Un apprenant ne voit (et ne peut ouvrir ou télécharger) que les ressources
--   liées aux webinaires où son inscription est approuvée, ou dans lesquels
--   l'organisateur l'a admis depuis la salle d'attente.

create or replace function public.can_see_resource(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('admin', 'encadreur')
      or exists (
        select 1
          from public.webinar_resources wr
          join public.registrations g on g.webinar_id = wr.webinar_id
         where wr.resource_id = r and g.apprenant_id = auth.uid() and g.status = 'approuve'
      )
      or exists (
        select 1
          from public.webinar_resources wr
          join public.lobby l on l.webinar_id = wr.webinar_id
         where wr.resource_id = r and l.user_id = auth.uid() and l.status in ('admis', 'parti')
      )
$$;

drop policy "lire la bibliothèque" on public.resources;
create policy "lire la bibliothèque" on public.resources for select to authenticated
  using (public.can_see_resource(id));

-- Même règle pour les fichiers eux-mêmes (ouverture et téléchargement).
drop policy "bibliothèque : lecture" on storage.objects;
create policy "bibliothèque : lecture" on storage.objects for select to authenticated
  using (
    bucket_id = 'bibliotheque'
    and (
      public.my_role() in ('admin', 'encadreur')
      or exists (select 1 from public.resources r where r.file_path = name and public.can_see_resource(r.id))
    )
  );

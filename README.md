# 🎥 WEBINAIRE

Plateforme de gestion de webinaires pour WOMMAT : planification, diffusion,
liste de présence automatique et bibliothèque de ressources.

Site : <https://fallthionakh.github.io/WEBINAIRE/>

## Rôles

| Rôle | Ce qu'il peut faire |
|---|---|
| 👑 Administrateur | Approuve ou suspend les comptes, donne l'accès encadreur (par e-mail), change les rôles, consulte la fiche de chaque utilisateur (connexions, durées, webinaires), voit et gère tous les webinaires |
| 🧑‍🏫 Encadreur | Crée, reprogramme et annule ses webinaires ; voit les inscrits et les présents ; exclut ou réintègre un apprenant ; dépose des ressources |
| 🎓 Apprenant | Crée son compte, s'inscrit à un ou plusieurs webinaires, rejoint le direct, consulte la bibliothèque |

## Fonctionnalités

- **Validation des comptes** : un apprenant qui s'inscrit reste « en attente » jusqu'à l'approbation de l'administrateur ; un compte suspendu perd immédiatement l'accès. Les encadreurs invités sont approuvés d'office.
- **Historique des connexions** : chaque visite est enregistrée (date, heure de connexion, heure de déconnexion, durée), avec la dernière connexion et le temps total, exportable en CSV.
- **Inscriptions aux webinaires** : l'apprenant demande à s'inscrire (page « Mes inscriptions », accessible aussi depuis son profil) ; l'encadreur du webinaire approuve, refuse, suspend ou réactive chaque demande (ou « Tout approuver »). Seules les inscriptions approuvées donnent accès au direct.
- **Ressources des webinaires** : depuis un webinaire, ajouter des ressources de la bibliothèque ou déposer un fichier ; depuis la bibliothèque, « Lier à un webinaire ». Une ressource peut servir à plusieurs webinaires.
- **Webinaires** : titre, description, date, heure de début, durée et heure de fin (calculées l'une de l'autre), reprogrammation (badge « Reprogrammé »), annulation avec motif.
- **Salle en direct** : caméra, partage d'écran, présentation PDF ou images (◀ ▶, flèches du clavier, depuis la bibliothèque), plein écran ; chat, questions et sondages en temps réel ; liste des participants en ligne avec bouton « Exclure ».
- **Liste de présence automatique** : chaque connexion est enregistrée par le serveur (date, heure de connexion, heure de déconnexion, durée), avec le total par apprenant et les absents. Export Excel / CSV.
- **Bibliothèque** : PDF, vidéos (lecture intégrée), PowerPoint, Word, Excel, images ; 50 Mo par fichier ; ressources liées à un webinaire.
- Interface responsive (ordinateur et téléphone), mode sombre automatique.

## Architecture

```
GitHub Pages (index.html, styles.css, app.js, config.js)
        │  supabase-js
        ▼
Supabase : Auth (comptes) · PostgreSQL + RLS (données et droits)
           Realtime (chat, sondages, présence) · Storage (bibliothèque)
```

Toute la sécurité est appliquée par la base de données (Row Level Security,
voir [`supabase/schema.sql`](supabase/schema.sql)) : la clé publique présente
dans `config.js` ne donne que les droits prévus pour chaque rôle. Aucun mot de
passe n'est stocké dans le code.

## Installation

1. Créer un projet sur [supabase.com](https://supabase.com) (offre gratuite).
2. Dans **SQL Editor**, exécuter dans l'ordre `supabase/schema.sql`, `supabase/002_approbation_connexions.sql`
   et `supabase/003_inscriptions_ressources.sql`.
3. Dans **Authentication → Sign In / Providers → Email**, désactiver *Confirm email*
   (ou configurer un serveur SMTP pour garder la confirmation).
4. Dans **Authentication → Users → Add user**, créer le compte administrateur
   `wommatsn@gmail.com` (cocher *Auto Confirm User*). Il reçoit automatiquement le rôle admin.
5. Dans **Authentication → URL Configuration**, mettre l'adresse du site en *Site URL*.
6. Copier l'URL du projet et la clé *publishable* (ou *anon*) dans `config.js`.

Pour une présentation PowerPoint pendant le direct, exportez-la d'abord en PDF
(*Fichier → Exporter → PDF*). Les PDF sont affichés avec
[pdf.js](https://mozilla.github.io/pdf.js/).

## Feuille de route

- [x] Comptes et rôles (admin, encadreur, apprenant)
- [x] Planification, reprogrammation, annulation
- [x] Liste de présence automatique et export
- [x] Bibliothèque de ressources
- [ ] Transmission vidéo WebRTC vers les apprenants (LiveKit, Jitsi ou Daily)
- [ ] Rappels par e-mail avant chaque webinaire (SMTP personnalisé)
- [ ] Enregistrement des replays dans la bibliothèque
- [ ] Attestations de présence en PDF

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
- **Visio (Daily)** : son et vidéo pour tous, partage d'écran pour l'encadreur et les apprenants ; l'encadreur (propriétaire de la salle) peut couper les micros et retirer un participant. Salle Daily privée : on n'y entre qu'avec un jeton délivré par la fonction `daily-token`, après vérification de l'inscription. Sans configuration Daily, la salle revient au mode local (caméra, partage d'écran et présentation visibles par l'encadreur seulement).
- **Salle d’attente** : toute personne connectée qui ouvre le lien de la salle attend d’être admise par l’organisateur (bandeau avec Admettre / Refuser / Tout admettre, notification sonore). Chaque retour (après avoir quitté, rechargé ou été retiré) repasse par la salle d’attente. Un compte pas encore validé par l’admin peut entrer par un lien si l’organisateur l’admet.
- **Salle en direct** : chat, questions et sondages en temps réel ; mains levées ; liste des participants avec « Retirer » ; « Agrandir » et plein écran pour tous ; « Copier le lien de la salle ».
- **Visio qui continue pendant la navigation** : pendant un direct, ouvrir une autre rubrique (Bibliothèque, Tableau de bord…) ne coupe pas l’appel : la visio passe dans une mini-fenêtre en bas à droite (« Revenir à la salle »). L’encadreur ne quitte la visio qu’avec « Terminer le direct » ; l’apprenant avec « Quitter la salle ».
- **Partage d’écran des apprenants** : bouton « 🖥️ Partager mon écran » sous la vidéo. Le partage d’écran n’est possible que depuis un ordinateur (Chrome, Edge, Firefox) : les navigateurs de téléphone et de tablette ne le permettent pas, un message l’explique.
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
   `supabase/003_inscriptions_ressources.sql`, `supabase/004_salle_attente.sql`, `supabase/005_mot_de_passe.sql`, `supabase/006_retour_salle.sql` et `supabase/007_ressources_inscrits.sql`.
3. Dans **Authentication → Sign In / Providers → Email**, désactiver *Confirm email*
   (ou configurer un serveur SMTP pour garder la confirmation).
4. Dans **Authentication → Users → Add user**, créer le compte administrateur
   `wommatsn@gmail.com` (cocher *Auto Confirm User*). Il reçoit automatiquement le rôle admin.
5. Dans **Authentication → URL Configuration**, mettre l'adresse du site en *Site URL*.
6. Copier l'URL du projet et la clé *publishable* (ou *anon*) dans `config.js`.
7. Visio : créer un compte [Daily](https://www.daily.co), ajouter sa clé API dans
   **Edge Functions → Secrets** sous le nom `DAILY_API_KEY`, puis déployer
   `supabase/functions/daily-token/index.ts` sous le nom `daily-token` (vérification JWT activée).
8. Mot de passe oublié : déployer `supabase/functions/admin-reset-password/index.ts` sous le nom
   `admin-reset-password` (aucun secret à ajouter : la clé secrète du projet est fournie par Supabase).

Pour une présentation PowerPoint pendant le direct, exportez-la d'abord en PDF
(*Fichier → Exporter → PDF*). Les PDF sont affichés avec
[pdf.js](https://mozilla.github.io/pdf.js/).

## Feuille de route

- [x] Comptes et rôles (admin, encadreur, apprenant)
- [x] Planification, reprogrammation, annulation
- [x] Liste de présence automatique et export
- [x] Bibliothèque de ressources
- [x] Visio pour tous les participants (Daily)
- [ ] Rappels par e-mail avant chaque webinaire (SMTP personnalisé)
- [ ] Enregistrement des replays dans la bibliothèque
- [ ] Attestations de présence en PDF

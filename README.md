# 🎥 WEBINAIRE

Plateforme de gestion de webinaires.

Ce dépôt contient une **première version (prototype front-end)** : elle tourne
entièrement dans le navigateur, sans serveur, et enregistre les données dans le
`localStorage`. Elle sert à valider les écrans et le parcours avant de
construire l'architecture complète décrite plus bas.

## Fonctionnalités

| Module | Dans ce prototype |
|---|---|
| 👥 Gestion des utilisateurs | Connexion par nom + e-mail, rôles *organisateur* / *participant* |
| 📅 Planification des webinaires | Création (titre, intervenant, date, durée, places), inscription / désinscription |
| 🎬 Diffusion en direct | Démarrer / terminer le direct, caméra, partage d'écran, présentation PDF ou images (flèches ◀ ▶ ou clavier), plein écran |
| 💬 Interaction en temps réel | Chat, questions avec votes, sondages (synchronisés entre onglets) |
| 📊 Analytics & Reporting | Inscriptions, taux de présence, messages, revenus par webinaire |
| 💰 Monétisation (optionnel) | Prix en FCFA par webinaire, revenus estimés |

## Lancer l'application

Aucune installation n'est nécessaire : ouvrez `index.html` dans un navigateur.

Pour tester le « temps réel », ouvrez l'application dans deux onglets :
un organisateur qui démarre le direct, un participant qui écrit dans le chat.

> La caméra et le partage d'écran ne fonctionnent que si la page est servie en
> `https://` ou depuis `localhost` (par exemple avec GitHub Pages). Le partage
> d'écran n'est pas disponible sur téléphone.

Pour une présentation PowerPoint, exportez-la d'abord en PDF
(*Fichier → Exporter → PDF*). Les PDF sont affichés avec
[pdf.js](https://mozilla.github.io/pdf.js/), chargé depuis cdnjs.

## Architecture cible

```
FRONTEND          React.js / Next.js + TypeScript, TailwindCSS,
                  Socket.io-client, WebRTC, Redux Toolkit / Zustand
BACKEND           Node.js (Express / NestJS) ou Django,
                  REST + GraphQL, Socket.io, BullMQ, JWT + OAuth2
BASES DE DONNÉES  PostgreSQL (données principales), Redis (cache, sessions, pub/sub),
                  MongoDB (logs, chat, analytics), S3 / MinIO (fichiers, vidéos)
```

## Structure

```
index.html   page principale
styles.css   styles (thème clair / sombre)
app.js       logique de l'application
```

## Feuille de route

- [x] Prototype front-end (ce dépôt)
- [ ] Migration vers Next.js + TypeScript + TailwindCSS
- [ ] API Node.js avec authentification JWT / OAuth2
- [ ] Base PostgreSQL pour les utilisateurs et les webinaires
- [ ] Chat et sondages en temps réel avec Socket.io + Redis
- [ ] Diffusion vidéo WebRTC vers les participants
- [ ] Enregistrement des replays (S3 / MinIO)
- [ ] Paiement en ligne des webinaires payants

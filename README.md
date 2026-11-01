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
| 🎬 Diffusion en direct | Démarrer / terminer le direct, aperçu caméra de l'organisateur |
| 💬 Interaction en temps réel | Chat, questions avec votes, sondages (synchronisés entre onglets) |
| 📊 Analytics & Reporting | Inscriptions, taux de présence, messages, revenus par webinaire |
| 💰 Monétisation (optionnel) | Prix en FCFA par webinaire, revenus estimés |

## Lancer l'application

Aucune installation n'est nécessaire : ouvrez `index.html` dans un navigateur.

Pour tester le « temps réel », ouvrez l'application dans deux onglets :
un organisateur qui démarre le direct, un participant qui écrit dans le chat.

> La caméra ne fonctionne que si la page est servie en `https://` ou depuis
> `localhost` (par exemple avec GitHub Pages).

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

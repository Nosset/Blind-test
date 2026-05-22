# 🎵 Blind Test Multijoueur Spotify

Application de blind test musical en temps réel, avec extraits Spotify, plusieurs modes de jeu et multijoueur sur mobile.

---

## 🚀 Déploiement en 10 minutes (Railway)

### 1. Credentials Spotify

1. Va sur https://developer.spotify.com/dashboard
2. Connecte-toi (compte gratuit suffisant)
3. Clique **Create app**
   - App name : `Blind Test`
   - Redirect URI : `http://localhost` (obligatoire mais non utilisé)
4. Copie ton **Client ID** et **Client Secret**

### 2. Déployer sur Railway (gratuit)

1. Crée un compte sur https://railway.app (avec GitHub)
2. Clique **New Project** → **Deploy from GitHub**
3. Importe ce repo (ou glisse le dossier)
4. Dans ton projet Railway → onglet **Variables** → ajoute :
   ```
   SPOTIFY_CLIENT_ID=xxxxx
   SPOTIFY_CLIENT_SECRET=xxxxx
   ```
5. Railway détecte automatiquement le `package.json` et lance `npm start`
6. Clique sur **Generate Domain** → tu obtiens ton URL publique !

### 3. Partage le lien

Une fois déployé, partage l'URL Railway à tes amis.  
Le host crée une salle, partage le code, et c'est parti !

---

## 🎮 Comment jouer

1. **Créer une partie** : choisis le mode, le thème, le nombre de questions
2. **Partage le code** (4 lettres) ou le lien direct à tes amis
3. Chacun rejoint sur son téléphone
4. L'hôte lance la partie
5. L'extrait joue automatiquement — réponds le plus vite possible (bonus de rapidité !)
6. Les scores s'affichent en temps réel après chaque manche

### Modes de jeu
- 🔀 **Aléatoire** : tous genres confondus
- 🏷️ **Par thème** : Rap FR, Hip-hop US, années 80/90/2000, Rock, Electro, R&B, Variété FR, Pop, Reggae, Metal
- 🎤 **Par artiste** : focus sur 1 ou plusieurs artistes

### Scoring
- Bonne réponse : **10 points**
- Bonus de rapidité : jusqu'à **+10 points** si tu réponds vite

---

## 💻 Lancer en local

```bash
# Installe les dépendances
npm install

# Configure tes credentials
cp .env.example .env
# Édite .env avec tes valeurs Spotify

# Lance le serveur
npm start
# ou en mode dev avec rechargement auto :
npm run dev
```

Ouvre http://localhost:3000

---

## 🏗️ Architecture

```
blindtest/
├── server.js          # Backend Node.js (Express + Socket.io + Spotify API)
├── public/
│   └── index.html     # Frontend mobile-first (HTML/CSS/JS vanilla)
├── package.json
├── .env.example
└── README.md
```

- **Backend** : Express sert le frontend statique + API REST Spotify + WebSockets Socket.io
- **Temps réel** : Socket.io pour synchroniser tous les joueurs (réponses, scores, navigation)
- **Spotify** : Client Credentials Flow (pas de login utilisateur requis) pour accéder aux previews 30s

---

## ⚠️ Note sur les previews Spotify

Spotify fournit des extraits de 30 secondes via `preview_url`. Certains morceaux n'en ont pas (environ 20-30% selon les marchés). L'app filtre automatiquement pour n'utiliser que les morceaux avec preview.

Si tu veux plus de morceaux disponibles, configure `market: 'FR'` dans `server.js` (déjà fait par défaut).

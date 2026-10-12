# Architecture de NexaAI

## Point de départ

Le dépôt ne contenait qu'un `README.md` de deux lignes : le code NexaAI existant sur l'ordinateur
Windows (interface Python, intégration Ollama, protections) n'a jamais été publié dans ce dépôt
et n'a donc pas pu être inspecté. NexaAI a été construit de zéro, en reprenant les choix qui rendent
la migration simple : **Python**, **Ollama** via son API HTTP standard (`/api/chat`, `/api/tags`),
permissions explicites. Si votre ancien code contient des fonctions à conserver, ajoutez-les comme
outil (voir plus bas) ou comme fournisseur.

## Choix de la technologie d'interface

| Option | Qualité visuelle | Dépendances | Caméra / micro / voix | Verdict |
|---|---|---|---|---|
| Tkinter | faible (aspect daté) | aucune | à coder entièrement | écarté |
| PySide6 / Qt | bonne | ~200 Mo, installation pip | QtMultimedia, complexe | écarté |
| **Serveur Python local + interface web en fenêtre d'application Edge/Chrome** | excellente (CSS moderne) | **aucune** | API natives du navigateur (getUserMedia, Web Speech, WebGL pour MediaPipe) | **retenu** |

Edge est présent sur tous les Windows 10/11 : NexaAI l'ouvre en mode `--app` (fenêtre dédiée, sans
barre d'adresse, profil séparé dans `%APPDATA%\NexaAI\browser-profile`). Aucun `npm install`,
aucune étape de compilation : les fichiers `web/` sont servis tels quels.

## Organisation

```
nexaai/                    Moteur (Python, bibliothèque standard uniquement)
  app.py                   Démarrage, ouverture de la fenêtre, arrêt propre, instance unique
  server.py                API HTTP locale (+ jeton, contrôle Host, CSP), flux NDJSON
  config.py                Réglages validés (settings.json) — chaque réglage est réellement utilisé
  storage.py               SQLite : conversations, messages, projets, mémoire, gestes, actions…
  chat.py                  Moteur de conversation : contexte, mémoire, boucle d'outils, annulation
  providers/
    base.py                Interface commune Provider, capacités, HTTP annulable
    ollama.py              Ollama (capacités lues via /api/show)
    openai_compat.py       Tout service compatible « Chat Completions » (distant ou local)
    registry.py            Catalogue + choix du modèle (modes local / distant / auto)
  tools/
    permissions.py         Dossiers et applications autorisés (résolution des chemins)
    executor.py            Validation → permissions → confirmation → exécution → journal
  files.py                 Lecture/écriture filtrées, sauvegardes, ouverture
  studio.py                Propositions de code et calcul de différences
  vision_assets.py         Installation vérifiée du moteur MediaPipe (à la demande)
  secrets_store.py         Clés API chiffrées (DPAPI sous Windows)
  logs.py                  Journal avec masquage des secrets
web/                       Interface (HTML/CSS/JS modules, sans compilation)
  css/app.css              Identité visuelle : jetons (couleurs, rayons…), composants, vues
  js/main.js               Structure, navigation, commandes, raccourcis, gestes → actions
  js/store.js              État global (dont l'état RÉEL du système lu par le compagnon)
  js/chat-controller.js    Envoi, flux, arrêt — indépendant de la page affichée
  js/companion.js          Compagnon (tête de robot à visière) et ses actions rapides
  js/commands.js           Registre de commandes + palette (Ctrl+K)
  js/voice.js              Dictée, synthèse, niveau du micro
  js/vision/hands.js       Caméra + MediaPipe Hand Landmarker
  js/vision/classifier.js  Normalisation des repères + k plus proches voisins + moteur anti-répétition
  js/views/*.js            Une vue par destination de la barre latérale
tests/                     Tests Python (unittest), JS (node --test), bout en bout (Playwright)
```

## Flux d'une question

1. `chat-controller.js` envoie `POST /api/conversations/{id}/messages`.
2. `chat.py` enregistre **immédiatement** le message de l'utilisateur (jamais perdu), crée un *job*
   dans un thread dédié et renvoie un flux NDJSON (`accepted`, `start`, `delta`…, `done`/`error`/`stopped`).
3. `registry.resolve()` choisit le modèle selon le mode, la préférence de la conversation et les
   capacités nécessaires (image jointe → modèle « vision »). Le choix et sa raison sont renvoyés.
4. Le contexte = consignes système + mémoire pertinente + contexte du projet + historique tenant
   dans la fenêtre du modèle.
5. Si le modèle propose un outil, `executor.run()` valide, contrôle les permissions **avant** toute
   demande de confirmation, attend l'accord de l'utilisateur pour les actions sensibles, exécute,
   journalise, puis renvoie le **résultat réel** au modèle (5 tours maximum).
6. *Arrêter* ferme immédiatement la connexion au fournisseur ; le texte déjà reçu est conservé.

Si la fenêtre est fermée ou rechargée pendant une génération, celle-ci continue et le résultat
est enregistré ; la page se rattache au flux en cours (`GET /api/jobs/{id}/stream`).

## Sécurité

- Serveur sur `127.0.0.1` uniquement ; jeton aléatoire par démarrage exigé sur `/api/*` ;
  vérification de l'en-tête `Host` ; politique CSP stricte (aucun script externe).
- Le modèle ne peut que *proposer* une action : il n'existe aucun outil « exécuter une commande ».
  Applications lancées sans interpréteur de commandes, depuis une liste blanche.
- Fichiers : chemins résolus (liens, `..`) avant contrôle ; racine d'un disque refusée ;
  chaque écriture sauvegarde la version précédente (`%APPDATA%\NexaAI\backups`).
- Aperçu HTML du Studio servi sur une page isolée (`sandbox`, `default-src 'none'`), scripts désactivés par défaut.
- Bascule vers un service distant : jamais silencieuse (consentement explicite dans les réglages,
  confirmation pour l'envoi de fichiers, modèle utilisé affiché sur chaque réponse).

## Performances

- Génération, téléchargements et outils hors du thread de l'interface ; serveur multi-thread.
- Rendu du texte progressif regroupé par image (`requestAnimationFrame`) ; seul le message en cours est redessiné.
- Vision limitée à `vision.max_fps` (15 par défaut) et suspendue quand la fenêtre est masquée ;
  flux caméra et micro réellement libérés (`track.stop()`).
- Animations CSS légères, désactivables (*Animations réduites*), respect de `prefers-reduced-motion`.
- Mesures (tests) : latence de l'API pendant une génération ≈ 1–2 ms ; recherche dans 2 000 messages ≈ 5 ms.

## Étendre NexaAI

**Nouveau fournisseur** : créer une classe dérivée de `providers.base.Provider`
(`health`, `list_models`, `chat`), puis la déclarer dans `providers/registry.py` (`provider()` et
`all_providers()`). L'interface n'a pas à changer.

**Nouvel outil pour l'agent** : dans `tools/executor.py`, `self.register(Tool(nom, description,
schéma JSON, risque, fonction, résumé, precheck=contrôle_de_permission))`. Le risque `high` impose
toujours une confirmation. Ajouter un test dans `tests/py/test_tools.py`.

**Nouvelle commande (palette, compagnon, gestes)** : `register({id, title, icon, group, run, enabled})`
dans `web/js/main.js`. Elle devient automatiquement disponible comme action de geste.

**Nouvelle page** : un module `web/js/views/<nom>.js` exportant `render(container, params, ctx)`
(qui renvoie une fonction de nettoyage), déclaré dans `views` et `NAV` de `main.js`.

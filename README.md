# NexaAI

Assistant personnel local, extensible et transparent : conversation avec des modèles d'IA
(locaux via Ollama ou distants), mémoire contrôlée, projets, fichiers autorisés, atelier de code,
voix, vision et gestes personnalisés, actions sur le PC sous contrôle.

> NexaAI privilégie les modèles **ouverts et locaux**. Il démarre sans aucune clé API.
> Les capacités réelles dépendent du modèle installé, du matériel et des autorisations accordées.

---

## Démarrage rapide (Windows)

1. **Python 3.10+** : <https://www.python.org/downloads/> — cochez « Add python.exe to PATH ».
   Aucune autre bibliothèque n'est nécessaire (NexaAI n'utilise que la bibliothèque standard).
2. **Ollama** (moteur local, recommandé) : <https://ollama.com/download>, puis dans un terminal :
   ```
   ollama pull llama3.2
   ```
   (ou téléchargez un modèle depuis NexaAI : *Paramètres › Intelligence artificielle › Télécharger un modèle*).
3. Double-cliquez sur **`start_nexaai.bat`**.
   Une fenêtre d'application (Microsoft Edge ou Google Chrome, sans barre d'adresse) s'ouvre.
   Fermer cette fenêtre arrête NexaAI proprement.

Commande exacte équivalente (depuis le dossier du projet) :

```
py -3 -m nexaai
```

Options : `--window browser` (onglet du navigateur ; NexaAI s'arrête 2 minutes après la fermeture du dernier onglet),
`--window none` (serveur seul, arrêt par *Ctrl+C*), `--port 8800`.
Sous macOS/Linux : `python3 -m nexaai`.

## Utilisation en 2 minutes

| Pour…                              | Faites…                                                                 |
|-----------------------------------|-------------------------------------------------------------------------|
| Poser une question                | Écrivez dans la zone du bas, *Entrée* pour envoyer (*Maj+Entrée* : retour à la ligne). |
| Arrêter une réponse               | Bouton carré à droite de la zone de saisie, ou *Échap*.                 |
| Changer de modèle                 | Bouton du modèle en haut de la conversation.                            |
| Local / distant / automatique     | Bouton « Local » sous la zone de saisie.                                |
| Joindre un fichier                | Trombone, glisser-déposer ou coller une image. Texte, code et images sont lus ; les autres formats sont signalés. |
| Dicter                            | Bouton micro (Edge/Chrome ; service en ligne du navigateur).            |
| Toutes les commandes              | *Ctrl+K* (palette), ou clic sur le robot en haut à gauche.              |
| Mémoriser une information         | Menu « … » d'un message › *Mémoriser*, ou page **Mémoire**.             |
| Donner accès à des fichiers       | **Fichiers › Autoriser un dossier** (lecture seule ou lecture-écriture). |
| Modifier du code avec l'IA        | **Création et code** › ouvrir un fichier › *Demander à NexaAI* › vérifier la différence › *Enregistrer*. |
| Gestes                            | **Vision et gestes** › installer le moteur (27 Mo, une fois) › *Bibliothèque des gestes* › *Nouveau geste*. |

## Ce qui fonctionne (vérifié)

Voir le détail et les limites dans [`docs/ETAT.md`](docs/ETAT.md). En résumé :

- conversation avec réponse progressive, arrêt réel, erreurs claires et *Réessayer*, historique persistant ;
- recherche, renommage, archivage, suppression (avec confirmation), export Markdown ;
- modes **local / distant / automatique** avec indication systématique du modèle réellement utilisé ;
  fournisseurs Ollama et compatibles OpenAI (OpenAI, Mistral, Groq, OpenRouter, LM Studio, llama.cpp…) ;
- capacités des modèles (images, outils, code) lues ou estimées, et choix d'un modèle compatible ;
- agent avec outils vérifiés : permissions, confirmation des actions sensibles, journal, résultat réel ;
- mémoire structurée (préférences, faits, notes de projet), consultable, modifiable, désactivable ;
- projets (description, notes, conversations et fichiers associés) ;
- atelier de code : édition, proposition de l'IA sous forme de différence, versions sauvegardées, aperçu HTML isolé ;
- compagnon visuel animé par l'état réel (veille, écoute, génération, parole, vision, erreur) ;
- palette de commandes (*Ctrl+K*), raccourcis configurables ;
- voix : dictée, lecture des réponses, test micro, conversation vocale continue (option) ;
- vision : caméra (éteinte par défaut, indicateur permanent), détection locale des mains (MediaPipe),
  apprentissage de gestes personnalisés, seuil, stabilité, anti-répétition, mode test.

## Tests

```
run_tests.bat                 (Windows)
python -m unittest discover -s tests/py -t .
node --test tests/js/classifier.test.mjs tests/js/markdown-commands.test.mjs
node tests/e2e/ui.e2e.mjs     (interface complète ; nécessite « npm install playwright »)
```

Résultats et tests manuels : [`docs/TESTS.md`](docs/TESTS.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — organisation du code, décisions techniques, comment ajouter un fournisseur, un outil ou une commande.
- [`docs/ETAT.md`](docs/ETAT.md) — fonctions opérationnelles, incomplètes, compatibilité.
- [`docs/TESTS.md`](docs/TESTS.md) — tests automatisés et procédures manuelles.

## Confidentialité

Toutes les données restent dans `%APPDATA%\NexaAI` (conversations, mémoire, gestes, journaux).
Rien n'est envoyé à un service distant en mode local. Les clés API sont chiffrées (DPAPI Windows)
et ne sont jamais affichées ni journalisées. Le serveur n'écoute que sur `127.0.0.1` et exige un jeton de session.

## Licences des composants intégrés

Police Inter et JetBrains Mono (SIL Open Font License), icônes Lucide (ISC) — voir `web/vendor/`.
Le moteur MediaPipe (Apache 2.0) est téléchargé à la demande et n'est pas inclus dans le dépôt.

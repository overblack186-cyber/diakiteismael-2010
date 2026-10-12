# Tests

## Tests automatisés

| Suite | Commande | Contenu | Résultat (12/10/2026) |
|---|---|---|---|
| Python | `python -m unittest discover -s tests/py -t .` | 85 tests : réglages, stockage et persistance, secrets, journal, fournisseurs, sélection du modèle, outils et permissions, conversation, serveur HTTP, performances, fermeture | **85/85 réussis** |
| JavaScript | `node --test tests/js/classifier.test.mjs tests/js/markdown-commands.test.mjs` | 11 tests : classificateur de gestes, moteur anti-répétition, Markdown sécurisé, palette | **11/11 réussis** |
| Bout en bout | `node tests/e2e/ui.e2e.mjs` (Playwright requis) | 14 scénarios dans Chromium sur la vraie interface | **14/14 réussis** |

Les tests Python et de bout en bout utilisent un **faux Ollama** et un **faux fournisseur distant**
(`tests/py/fakes.py`) qui reproduisent le format exact des API (flux NDJSON / SSE, erreurs,
capacités). Ils vérifient tout le logiciel, mais **pas** la qualité d'un vrai modèle.

### Couverture par domaine (exigences de la partie 15)

- **Application** : démarrage, arrêt propre (y compris pendant une génération), nouvelle conversation,
  navigation, changement de page, persistance après redémarrage (conversations, réglages, gestes).
- **Conversation** : envoi, réponse, streaming, arrêt, erreurs (moteur absent, erreur du modèle),
  *Réessayer*, régénération, modification, historique fourni au modèle, mémoire, contexte de projet,
  images vers un modèle « vision », fichiers texte lus.
- **Fournisseurs** : détection d'Ollama, modèle indisponible, Ollama injoignable, API distante
  configurée, clé manquante, clé refusée, limite quotidienne, mode automatique avec et sans
  consentement à la bascule distante, envoi de fichiers distant soumis à confirmation.
- **Outils** : permission accordée, refusée (hors dossier, « .. », lien symbolique, lecture seule),
  action confirmée, refusée, annulée, échec réel signalé, application non autorisée, arguments dangereux refusés.
- **Gestes** : normalisation (position, échelle, rotation, main gauche), reconnaissance, rejet d'un
  geste inconnu, seuil, stabilité, anti-répétition et relâchement, sensibilité, cohérence des exemples,
  enregistrement, rechargement après redémarrage, désactivation, mode test sans exécution.
- **Vision** : activation/désactivation de la caméra simulée, indicateur, libération du flux,
  installation réelle du moteur MediaPipe et chargement (GPU logiciel).
- **Performances** : latence de l'API pendant une génération longue (≈ 1,3 ms en moyenne, 2,1 ms max),
  recherche dans 2 000 messages (≈ 5 ms), aucun blocage de l'interface.
- **Sécurité** : jeton obligatoire, contrôle de l'en-tête Host, traversée de répertoires, clé API
  jamais renvoyée, aperçu HTML isolé, régression « corps de requête non lu ».

## Tests manuels à faire sur votre PC (non réalisables dans l'environnement de développement)

L'environnement de développement n'avait ni Ollama (téléchargement bloqué), ni caméra physique,
ni microphone, ni voix de synthèse, ni Windows. Ces points sont implémentés mais **non vérifiés** :

1. **Ollama réel** : lancez Ollama, `ollama pull llama3.2`, ouvrez NexaAI, posez une question.
   Attendu : réponse progressive, badge « local », nom du modèle et vitesse (jetons/s) sous la réponse.
   Testez *Arrêter* au milieu d'une longue réponse.
2. **Modèle vision** : `ollama pull llava` (ou `gemma3`), joignez une photo, demandez de la décrire.
3. **Caméra** : Vision et gestes › *Activer la caméra* (autorisez Edge). Vérifiez l'indicateur dans la
   barre latérale, puis *Désactiver* : le voyant de la webcam doit s'éteindre.
4. **Gestes** : *Installer* le moteur, *Détecter les gestes*, puis Bibliothèque › *Nouveau geste*,
   12 exemples « main ouverte », test, action « Nouvelle conversation », enregistrer. Laissez le *mode test*
   activé pour vérifier la reconnaissance, puis désactivez-le.
5. **Voix** : Voix › *Tester le microphone* (la barre doit bouger), *Écouter* (synthèse), *Dicter*.
   Puis dans une conversation : micro → parlez → corrigez → *Entrée*.
6. **Fenêtre et fermeture** : `start_nexaai.bat` ouvre une fenêtre sans barre d'adresse ; la fermer arrête
   le serveur (la console se ferme).
7. **Clé API** (facultatif) : Paramètres › IA › *Ajouter* un fournisseur, *Tester*.
8. **Sélecteur natif** : Fichiers › *Autoriser un dossier* › *Parcourir…*.

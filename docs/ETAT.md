# État des fonctionnalités

Légende : **Opérationnel** = implémenté et vérifié par des tests automatisés (et/ou dans le navigateur) ;
**À vérifier sur votre PC** = implémenté, mais dépend d'un matériel ou d'un service non disponible
dans l'environnement de développement ; **Non fait** = prévu, non implémenté (aucun bouton factice
n'est affiché pour ces fonctions).

## Interface et navigation

| Fonction | État |
|---|---|
| 11 destinations de la barre latérale, barre rétractable (*Ctrl+B*), récentes | Opérationnel |
| Thème sombre / clair, animations réduites, adaptation aux petites largeurs | Opérationnel |
| Panneau contextuel (modèle utilisé, mémoire fournie, actions, pièces jointes) | Opérationnel |
| Palette de commandes (*Ctrl+K*), filtrage local, raccourcis configurables | Opérationnel |
| Compagnon : états réels, actions rapides (clic), options (clic droit) | Opérationnel |
| Synchronisation de la parole du compagnon | Implémenté (événements « mot » de la synthèse) — à vérifier sur votre PC, dépend de la voix |

## Conversation

| Fonction | État |
|---|---|
| Envoi, réponse progressive, arrêt immédiat, réponse partielle conservée | Opérationnel |
| Erreur claire + *Réessayer*, message de l'utilisateur jamais perdu | Opérationnel |
| Régénérer, modifier et renvoyer, supprimer, copier, lire à voix haute | Opérationnel |
| Informations sur le modèle, signalement (enregistré localement) | Opérationnel |
| Pièces jointes : texte/code (lus), images (modèles « vision ») | Opérationnel |
| PDF, Word, Excel | **Non fait** : signalés « format non pris en charge », jamais envoyés |
| Reprise d'une génération après rechargement de la page | Opérationnel côté serveur (test automatisé) ; rattachement de l'interface non testé automatiquement |
| Notifications système en arrière-plan | Opérationnel (permission du navigateur requise) |

## Modèles et fournisseurs

| Fonction | État |
|---|---|
| Ollama : détection, liste réelle, capacités déclarées, téléchargement de modèles | Opérationnel (testé avec un faux Ollama au format exact de l'API) — **à vérifier avec votre Ollama** |
| Fournisseurs compatibles OpenAI (distants et locaux : LM Studio, llama.cpp) | Opérationnel (faux serveur) — à vérifier avec votre clé |
| Modes local / distant / automatique, bascule distante uniquement si autorisée | Opérationnel |
| Clés chiffrées (DPAPI), jamais réaffichées ni journalisées ; limite quotidienne | Opérationnel (DPAPI : à vérifier sous Windows) |
| Raisonnement fourni par le modèle (modèles « thinking ») | Affiché tel que renvoyé, replié |

## Agent, fichiers, PC

| Fonction | État |
|---|---|
| Outils : lister/lire/chercher des fichiers, ouvrir, lancer une application autorisée, écrire un fichier, mémoriser, date | Opérationnel |
| Permissions vérifiées avant confirmation ; confirmation des actions sensibles ; annulation | Opérationnel |
| Journal des actions (page Contrôle du PC) | Opérationnel |
| Dossiers autorisés (lecture / lecture-écriture), navigation, aperçu texte et image | Opérationnel |
| Sélecteur de dossier natif Windows (« Parcourir… ») | À vérifier sur votre PC (Tkinter, inclus dans Python pour Windows) |
| Ouverture avec l'application par défaut, lancement d'applications | À vérifier sur votre PC (`os.startfile`) |
| Email, navigateur web piloté, installation de logiciels | **Non fait** volontairement (aucune intégration fictive) |

## Projets, mémoire, Studio

| Fonction | État |
|---|---|
| Projets : nom, description, notes fournies au modèle, conversations et fichiers associés | Opérationnel |
| Mémoire : préférences / faits / notes de projet, activation, injection, modification, suppression, effacement total | Opérationnel |
| Studio : édition, proposition de l'IA en différence, application, enregistrement avec sauvegarde, versions, aperçu HTML isolé | Opérationnel |
| Analyse automatique du contenu des fichiers d'un projet | **Non fait** (seuls les noms sont fournis ; joignez le fichier pour qu'il soit lu) |

## Voix

| Fonction | État |
|---|---|
| Dictée (Web Speech du navigateur), correction avant envoi | À vérifier sur votre PC (service en ligne de Microsoft/Google, non disponible ici) |
| Synthèse vocale (voix Windows), voix, vitesse, volume, arrêt immédiat | À vérifier sur votre PC (aucune voix installée dans l'environnement de test) |
| Test du micro (niveau mesuré localement), choix du micro | À vérifier sur votre PC |
| Conversation vocale continue (option explicite) | Implémenté — à vérifier sur votre PC |
| Choix des haut-parleurs | **Non disponible** : la synthèse du navigateur utilise la sortie par défaut de Windows (contrôle désactivé avec explication) |
| Reconnaissance vocale 100 % locale (Whisper) | **Non fait** : nécessiterait un modèle Whisper (non téléchargeable dans l'environnement de développement) |

## Vision et gestes

| Fonction | État |
|---|---|
| Caméra éteinte au démarrage, activation, choix du périphérique, libération | Opérationnel (caméra simulée par Chromium) — **caméra physique à vérifier** |
| Indicateur permanent « Caméra active » | Opérationnel |
| Moteur MediaPipe : téléchargement unique vérifié (SHA-512 / SHA-256), exécution locale GPU ou CPU | Opérationnel (installé et chargé dans Chromium ; 3 images/s en GPU logiciel ici) |
| Repères de la main, geste reconnu, confiance, historique de session | Opérationnel |
| Apprentissage : nom, nombre d'exemples, capture guidée, contrôle de cohérence, test, action, enregistrement | Opérationnel (repères simulés en test automatique) — **précision sur une vraie main à vérifier** |
| Renommer, ajouter des exemples, sensibilité, action, désactiver, supprimer | Opérationnel |
| Seuil, stabilité, anti-répétition + relâchement, mode test, confirmation des actions sensibles, pause immédiate | Opérationnel |

## Compatibilité

- **Windows 10/11** : cible principale. Edge (préinstallé) ou Chrome pour la fenêtre d'application.
- **Python 3.10+** requis (testé avec 3.13). Aucune dépendance pip.
- **Firefox** : fonctionne en mode `--window browser`, mais sans dictée (pas de Web Speech Recognition).
- macOS/Linux : fonctionnement de base vérifié sous Linux ; chiffrement des clés par droits de fichier (pas DPAPI).
- Mémoire vive : un modèle local de 3 milliards de paramètres demande environ 4 Go ; 7–8 milliards ≈ 8 Go.
- Port par défaut 8765 (un port libre est choisi automatiquement s'il est occupé).

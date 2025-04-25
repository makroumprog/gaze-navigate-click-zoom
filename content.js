// GazeTech Content Script
// This script is injected into web pages to enable eye tracking control

// Main state variables
let isActive = true;
let isCalibrated = false;
let settings = {};
let faceModel = null;
let eyeTracker = null;
let webcamStream = null;
let faceMesh = null;
let cameraInitialized = false;
let tabInFocus = true; // Track if tab is in focus
let forceKeepCameraOn = true; // Flag to force keeping camera on even when tab loses focus

// Element refs
let video = null;
let canvas = null;
let cursor = null;
let lastGazePoint = { x: 0, y: 0 };
let lastEyeState = { isBlinking: false, lastBlinkTime: Date.now() };
let lastGazeTime = Date.now();
let lastZoomElement = null;
let lastTextElement = null;
let isScrolling = false;
let isSpeaking = false;
let speechSynthesis = window.speechSynthesis;
let calibrationData = null; // Pour stocker les données de calibration
let eyeMovementSensitivity = 9; // Sensibilité augmentée (était 7) pour des mouvements encore plus réactifs
let restoreCameraAttempts = 0;
const MAX_RESTORE_ATTEMPTS = 30; // Augmenté encore le maximum de tentatives pour une persistance extrême
let cameraRestorationInProgress = false;
let cameraRestorationQueue = []; // Queue pour gérer plusieurs requêtes de restauration
let permissionDenied = false; // New flag to track permission denial

// Persistance de l'activation de la caméra
let lastHeartbeatTime = 0;
const HEARTBEAT_INTERVAL = 200; // Battements de cœur très fréquents pour une meilleure fiabilité
let pendingForceActivation = false;
let lastRestorationAttemptTime = 0;
const MIN_RESTORATION_INTERVAL = 200; // Intervalle minimum réduit entre les tentatives de restauration

// Paramètres de suivi améliorés
let headTracking = {
  xOffset: 0,
  yOffset: 0,
  xScale: 4.5, // Amplification du mouvement considérablement augmentée (était 3.5)
  yScale: 4.5, // Amplification du mouvement considérablement augmentée (était 3.5)
  smoothFactor: 0.05 // Lissage encore plus réduit pour une réponse quasi immédiate (était 0.10)
};

// Mode debug pour montrer plus de retour visuel
let debugMode = true;

// Suivi de fin de calibration
let justCalibrated = false;

// Indicateur pour forcer une persistance extrême de la caméra
let forceCameraPersistence = true;

// Nombre de tentatives de restauration pour différentes stratégies
let emergencyRestoreAttempts = 0;

// Charger les paramètres depuis le stockage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      settings = items;
      isActive = settings.isActive;
      isCalibrated = settings.calibrated;
      calibrationData = settings.calibrationData;
      
      // Appliquer la sensibilité du mouvement des yeux à partir des paramètres
      if (settings.gazeSensitivity) {
        eyeMovementSensitivity = settings.gazeSensitivity + 2; // Ajoute 2 pour plus de réactivité
        // Mettre à jour les facteurs d'échelle en fonction de la sensibilité
        headTracking.xScale = 3.0 + (eyeMovementSensitivity * 0.8); // Plage plus dynamique pour le mouvement du curseur
        headTracking.yScale = 3.0 + (eyeMovementSensitivity * 0.8);
        // Ajuster le lissage pour être plus réactif à haute sensibilité
        headTracking.smoothFactor = Math.max(0.01, 0.15 - (eyeMovementSensitivity * 0.02));
      }
      
      resolve(settings);
    });
  });
}

// Démarrer le heartbeat pour garder la caméra active entre les onglets - version améliorée
function startHeartbeat() {
  // Effacer tout intervalle existant
  if (window.heartbeatInterval) {
    clearInterval(window.heartbeatInterval);
  }
  
  // Configurer un heartbeat régulier pour garder la caméra en vie - plus fréquent
  window.heartbeatInterval = setInterval(() => {
    if (!document.hidden || forceKeepCameraOn || forceCameraPersistence) {
      const now = Date.now();
      if (now - lastHeartbeatTime > HEARTBEAT_INTERVAL) {
        lastHeartbeatTime = now;
        
        // Envoyer le heartbeat au script de fond
        chrome.runtime.sendMessage({
          action: 'heartbeat',
          hasCameraActive: cameraInitialized,
          requestForceCheck: true // Toujours demander une vérification forcée
        }).then(response => {
          if (response && response.shouldHaveCamera && !cameraInitialized) {
            console.log("Heartbeat: La caméra devrait être active, restauration");
            // Passer l'indicateur de force si le script de fond le demande
            restoreCamera(true);
          }
          
          // Mettre à jour l'indicateur de persistance depuis le background
          if (response && response.forcePersistence) {
            forceCameraPersistence = true;
            forceKeepCameraOn = true;
          }
        }).catch(error => {
          console.log("Erreur de heartbeat:", error);
          // En cas d'erreur, essayer de restaurer la caméra quand même
          if (!cameraInitialized && (forceKeepCameraOn || forceCameraPersistence)) {
            restoreCamera(true);
          }
        });
      }
    }
  }, HEARTBEAT_INTERVAL);
  
  // Ajouter un intervalle secondaire "keepalive" encore plus agressif
  window.keepAliveInterval = setInterval(() => {
    if (cameraInitialized && webcamStream) {
      // Vérifier que le flux de la caméra est réellement actif
      const activeTracks = webcamStream.getVideoTracks().filter(track => track.readyState === 'live');
      if (activeTracks.length === 0) {
        console.log("KeepAlive: Flux de caméra perdu, tentative de restauration");
        cameraInitialized = false;
        restoreCamera(true);
      }
    } else if (forceCameraPersistence || justCalibrated) {
      // Si la caméra devrait être active mais ne l'est pas, la restaurer
      restoreCamera(true);
    }
  }, 800); // Légèrement plus fréquent
  
  // Ajouter une troisième vérification d'urgence de la caméra - encore plus agressive
  window.emergencyCameraInterval = setInterval(() => {
    if (forceCameraPersistence || justCalibrated) {
      // Forcer la restauration de la caméra de toute façon, quel que soit l'état
      emergencyRestoreAttempts++;
      
      // Utiliser différentes stratégies selon le nombre de tentatives
      const useAggressive = emergencyRestoreAttempts % 3 === 0;
      restoreCamera(useAggressive);
      
      // Réinitialiser l'indicateur de calibration après un moment
      if (justCalibrated && Date.now() - lastRestorationAttemptTime > 5000) {
        justCalibrated = false;
      }
    }
  }, 2000); // Plus fréquent
  
  // Intervalle de synchronisation ultra-agressif pour les changements d'onglets
  window.tabSwitchInterval = setInterval(() => {
    if (!document.hidden && (forceCameraPersistence || forceKeepCameraOn)) {
      chrome.runtime.sendMessage({
        action: 'forceCameraActivation',
        urgent: true
      }).catch(() => {});
    }
  }, 5000);
}

// Initialiser les éléments d'interface avec option de débogage
function initializeUI() {
  // Créer l'élément du curseur - plus visible maintenant
  cursor = document.createElement('div');
  cursor.id = 'gazetech-cursor';
  cursor.style.cssText = `
    position: fixed;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background-color: rgba(44, 123, 229, 0.7);
    border: 3px solid rgba(44, 123, 229, 0.9);
    pointer-events: none;
    z-index: 999999;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 15px rgba(44, 123, 229, 0.7);
    display: ${isActive ? 'block' : 'none'};
    transition: transform 0.01s ease-out, background-color 0.2s; 
  `;
  document.body.appendChild(cursor);

  // Créer l'élément vidéo de la webcam (caché)
  video = document.createElement('video');
  video.id = 'gazetech-video';
  video.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    z-index: -1;
  `;
  video.autoplay = true;
  video.playsInline = true; // Important pour iOS
  video.muted = true; // Requis pour l'autoplay dans certains navigateurs
  video.setAttribute('playsinline', ''); // Supplémentaire pour iOS
  document.body.appendChild(video);

  // Créer un canvas pour le traitement (caché)
  canvas = document.createElement('canvas');
  canvas.id = 'gazetech-canvas';
  canvas.width = 640;
  canvas.height = 480;
  canvas.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    z-index: -1;
  `;
  document.body.appendChild(canvas);
  
  // Ajouter un indicateur de débogage - toujours le créer mais l'afficher conditionnellement
  const debugIndicator = document.createElement('div');
  debugIndicator.id = 'gazetech-debug';
  debugIndicator.style.cssText = `
    position: fixed;
    bottom: 10px;
    right: 10px;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 14px;
    font-family: Arial, sans-serif;
    z-index: 999999;
    display: ${debugMode ? 'block' : 'none'};
    transition: opacity 0.3s ease;
  `;
  debugIndicator.textContent = "GazeTech initialisation...";
  document.body.appendChild(debugIndicator);
  
  // Ajouter un indicateur d'état pour montrer l'état de la caméra
  const statusIndicator = document.createElement('div');
  statusIndicator.id = 'gazetech-status';
  statusIndicator.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background-color: red;
    z-index: 999999;
    box-shadow: 0 0 5px rgba(0, 0, 0, 0.5);
    display: ${debugMode ? 'block' : 'none'};
  `;
  document.body.appendChild(statusIndicator);
  
  // Ajout d'un message persistant de caméra
  const persistentMessage = document.createElement('div');
  persistentMessage.id = 'gazetech-persistent';
  persistentMessage.style.cssText = `
    position: fixed;
    top: 40px;
    right: 10px;
    background-color: rgba(50, 205, 50, 0.9);
    color: white;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 12px;
    font-family: Arial, sans-serif;
    z-index: 999999;
    display: none;
    transition: opacity 0.3s ease;
  `;
  persistentMessage.textContent = "Caméra persistante activée";
  document.body.appendChild(persistentMessage);
  
  // Afficher le message persistant brièvement
  setTimeout(() => {
    persistentMessage.style.display = 'block';
    setTimeout(() => {
      persistentMessage.style.opacity = '0';
      setTimeout(() => {
        persistentMessage.style.display = 'none';
        persistentMessage.style.opacity = '1';
      }, 500);
    }, 3000);
  }, 1000);

  // Ajouter un élément pour afficher les erreurs de permission caméra de façon plus visible
  const permissionError = document.createElement('div');
  permissionError.id = 'gazetech-permission-error';
  permissionError.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    background-color: rgba(220, 53, 69, 0.9);
    color: white;
    padding: 10px 15px;
    border-radius: 8px;
    font-size: 15px;
    font-family: Arial, sans-serif;
    z-index: 9999999;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    display: none;
    transition: opacity 0.3s ease;
    pointer-events: auto;
    cursor: pointer;
  `;
  permissionError.textContent = "Erreur caméra: Permission denied";
  permissionError.onclick = function() {
    showPermissionHelp();
  };
  document.body.appendChild(permissionError);
}

// Nouvelle fonction pour afficher une aide sur les autorisations de caméra
function showPermissionHelp() {
  const helpModal = document.createElement('div');
  helpModal.id = 'gazetech-permission-help';
  helpModal.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: white;
    color: #333;
    padding: 25px;
    border-radius: 10px;
    font-size: 14px;
    font-family: Arial, sans-serif;
    z-index: 9999999;
    box-shadow: 0 10px 20px rgba(0, 0, 0, 0.3);
    max-width: 85%;
    width: 450px;
    text-align: left;
    line-height: 1.5;
  `;
  
  helpModal.innerHTML = `
    <h3 style="margin-top: 0; color: #c00; margin-bottom: 15px;">Accès à la caméra refusé</h3>
    <p>GazeTech a besoin d'accéder à votre caméra pour le suivi oculaire. Pour autoriser l'accès :</p>
    <ol style="padding-left: 20px; margin-bottom: 15px;">
      <li>Cliquez sur l'icône de cadenas/info dans la barre d'adresse</li>
      <li>Trouvez les paramètres de "Caméra" ou "Permissions du site"</li>
      <li>Réglez l'autorisation de la caméra sur "Autoriser"</li>
      <li>Rechargez la page</li>
    </ol>
    <p style="margin-bottom: 20px;">Si le problème persiste, vérifiez les autorisations de caméra dans les paramètres de votre navigateur.</p>
    <button id="gazetech-permission-close" style="background: #0066cc; color: white; padding: 8px 15px; border: none; border-radius: 5px; cursor: pointer;">Fermer</button>
    <button id="gazetech-permission-retry" style="background: #28a745; color: white; padding: 8px 15px; border: none; border-radius: 5px; margin-left: 10px; cursor: pointer;">Réessayer</button>
  `;
  
  document.body.appendChild(helpModal);
  
  // Ajouter le gestionnaire pour le bouton de fermeture
  document.getElementById('gazetech-permission-close').addEventListener('click', () => {
    document.body.removeChild(helpModal);
  });
  
  // Ajouter le gestionnaire pour le bouton de réessai
  document.getElementById('gazetech-permission-retry').addEventListener('click', () => {
    document.body.removeChild(helpModal);
    permissionDenied = false; // Réinitialiser l'indicateur de refus
    restoreCamera(true); // Tenter une nouvelle initialisation de la caméra
  });
  
  // Ajouter un overlay semi-transparent
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 9999998;
  `;
  document.body.appendChild(overlay);
  
  // Fermer le modal si on clique sur l'overlay
  overlay.addEventListener('click', () => {
    document.body.removeChild(helpModal);
    document.body.removeChild(overlay);
  });
}

// Fonction pour mettre à jour l'indicateur d'état
function updateStatusIndicator(active) {
  const indicator = document.getElementById('gazetech-status');
  if (indicator) {
    indicator.style.backgroundColor = active ? 'lime' : 'red';
    indicator.style.boxShadow = active 
      ? '0 0 10px rgba(0, 255, 0, 0.7)' 
      : '0 0 5px rgba(255, 0, 0, 0.7)';
  }
}

// Afficher une notification temporaire
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 40px;
    right: 10px;
    background-color: ${type === 'error' ? 'rgba(220, 53, 69, 0.9)' : 'rgba(25, 135, 84, 0.9)'};
    color: white;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 14px;
    font-family: Arial, sans-serif;
    z-index: 999999;
    transition: opacity 0.3s ease;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  // Supprimer la notification après quelques secondes
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

// Afficher l'erreur de permission caméra
function showCameraPermissionError(show = true) {
  const errorElement = document.getElementById('gazetech-permission-error');
  if (errorElement) {
    if (show) {
      errorElement.style.display = 'block';
      // Animation légère pour attirer l'attention
      setTimeout(() => {
        errorElement.style.transform = 'translateX(-50%) translateY(5px)';
        setTimeout(() => {
          errorElement.style.transform = 'translateX(-50%) translateY(0)';
        }, 200);
      }, 100);
    } else {
      errorElement.style.display = 'none';
    }
  }
  
  // Si on montre l'erreur, mettre à jour le statut aussi
  if (show) {
    updateStatusIndicator(false);
    
    // Notifier l'extension du problème de permission
    chrome.runtime.sendMessage({
      action: 'cameraPermissionDenied'
    }).catch(() => {});
  }
}

// Fonction pour forcer la restauration de la caméra avec recul exponentiel
function restoreCamera(force = false) {
  console.log("Tentative de restauration de la caméra, force:", force);
  
  if (cameraInitialized && !force) {
    console.log("Caméra déjà initialisée, pas besoin de restaurer");
    return;
  }

  // Utiliser un recul exponentiel pour éviter trop de tentatives rapides de restauration
  const now = Date.now();
  if (now - lastRestorationAttemptTime < MIN_RESTORATION_INTERVAL && !force) {
    console.log("Trop tôt pour réessayer la restauration");
    
    // Programme une tentative ultérieure quand même
    setTimeout(() => restoreCamera(true), MIN_RESTORATION_INTERVAL);
    return;
  }
  
  lastRestorationAttemptTime = now;
  restoreCameraAttempts++;
  
  // N'autoriser qu'un certain nombre de tentatives de restauration pour éviter les blocages du navigateur
  // Mais ignorer cette limite si force est true
  if (restoreCameraAttempts > MAX_RESTORE_ATTEMPTS && !force) {
    console.log("Nombre maximum de tentatives atteint, abandon");
    
    // Mais quand même essayer une dernière fois avec force dans ce cas
    setTimeout(() => restoreCamera(true), 1000);
    return;
  }
  
  // Afficher une notification que nous restaurons la caméra
  showNotification("Restauration de la caméra...");
  
  // Forcer l'initialisation du suivi avec l'indicateur de force
  initializeTracking(force);
  
  // Planifier des tentatives supplémentaires de restauration
  if ((force || forceCameraPersistence) && !cameraInitialized) {
    // Réessayer après des délais avec un recul exponentiel et plusieurs stratégies
    [300, 600, 1000, 1500, 2500, 4000].forEach((delay, index) => {
      setTimeout(() => {
        if (!cameraInitialized) {
          // Alterner entre différentes stratégies d'initialisation
          initializeTracking(index % 2 === 0);
        }
      }, delay);
    });
  }
}

// Initialiser la webcam et le suivi du visage avec une gestion d'erreur améliorée et restauration
async function initializeTracking(force = false) {
  if (cameraInitialized && !force) {
    console.log('Caméra déjà initialisée, ignorer');
    return;
  }
  
  if (permissionDenied && !force) {
    console.log('Permission déjà refusée, ne pas réessayer sans action explicite');
    showCameraPermissionError(true);
    return;
  }
  
  if (cameraRestorationInProgress && !force) {
    console.log('Restauration de caméra déjà en cours, mise en file d\'attente de la demande');
    cameraRestorationQueue.push(Date.now());
    return;
  }
  
  // Pour une persistance extrême
  if (force) {
    // Tuer toute restauration en cours
    cameraRestorationInProgress = false;
    
    // Effacer d'abord les ressources webcam existantes
    if (webcamStream) {
      try {
        webcamStream.getTracks().forEach(track => {
          try { track.stop(); } catch (e) {}
        });
        webcamStream = null;
      } catch (e) {
        console.log('Erreur lors de l\'arrêt des pistes existantes:', e);
      }
    }
  }
  
  // Reporter les tentatives de restauration
  const now = Date.now();
  if (now - lastRestorationAttemptTime < MIN_RESTORATION_INTERVAL && !force) {
    console.log('Tentative de restauration trop tôt, délai');
    setTimeout(() => {
      initializeTracking(force);
    }, MIN_RESTORATION_INTERVAL);
    return;
  }
  
  lastRestorationAttemptTime = now;
  cameraRestorationInProgress = true;
  cameraRestorationQueue = [];
  updateStatusIndicator(false);
  
  // Journal de tentative d'initialisation
  console.log('GazeTech: Tentative d\'initialisation webcam avec force =', force);
  
  // Effacer les ressources webcam existantes
  if (webcamStream) {
    try {
      webcamStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      webcamStream = null;
    } catch (e) {
      console.log('Erreur lors de l\'arrêt des pistes existantes:', e);
    }
  }

  try {
    // Accéder à la webcam avec des contraintes plus spécifiques et des drapeaux de persistance
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        width: { ideal: 640, min: 320 },
        height: { ideal: 480, min: 240 }, 
        facingMode: "user",
        frameRate: { ideal: 30, min: 20 }  
      },
      audio: false
    });
    
    // Cacher l'erreur de permission si elle était affichée
    showCameraPermissionError(false);
    permissionDenied = false;
    
    video.srcObject = webcamStream;
    
    // Ajouter des drapeaux de persistance aux pistes du flux
    webcamStream.getTracks().forEach(track => {
      // Ce sont des drapeaux non officiels mais qui pourraient aider dans certains navigateurs
      track.contentHint = "persist";
      track.enabled = true; // S'assurer que la piste est activée
    });
    
    // S'assurer que la vidéo se lance automatiquement avec une meilleure récupération d'erreur
    video.onloadedmetadata = async () => {
      try {
        await video.play();
      } catch (e) {
        console.error('GazeTech: Erreur de lecture vidéo:', e);
        // Réessayer après un court délai
        setTimeout(() => {
          video.play().catch(e => console.log('Deuxième tentative de lecture échouée:', e));
        }, 200);
      }
    };
    
    // Attendre que la vidéo soit prête avec un timeout et plusieurs tentatives
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout de lecture vidéo'));
      }, 5000);
      
      let playAttempts = 0;
      
      const tryPlay = () => {
        playAttempts++;
        video.play()
          .then(resolve)
          .catch(e => {
            if (playAttempts < 7) { // Augmenté de 5 à 7
              console.log(`Tentative de lecture ${playAttempts} échouée, réessai:`, e);
              setTimeout(tryPlay, 300);
            } else {
              reject(e);
            }
          });
      };
      
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        tryPlay();
      };
      
      video.onerror = (e) => {
        clearTimeout(timeout);
        reject(e);
      };
    });
    
    cameraInitialized = true;
    cameraRestorationInProgress = false;
    
    // Réinitialiser le compteur de tentatives de restauration sur initialisation réussie
    restoreCameraAttempts = 0;
    
    // Afficher les infos de débogage
    const debugIndicator = document.getElementById('gazetech-debug');
    if (debugIndicator) {
      debugIndicator.textContent = "Caméra initialisée. En attente de détection de visage...";
      debugIndicator.style.display = "block";
      setTimeout(() => {
        if (debugMode) {
          debugIndicator.style.opacity = "0.7";
        } else {
          debugIndicator.style.display = "none";
        }
      }, 3000);
    }
    
    // Mettre à jour l'indicateur d'état
    updateStatusIndicator(true);
    
    // Afficher une notification
    showNotification("Caméra activée", "info");
    
    // Notifier le script de fond que la caméra est active
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: true,
      requiresPersistence: forceKeepCameraOn || forceCameraPersistence || justCalibrated
    }).catch(error => {
      console.log("Échec de notification du script de fond sur l'état de la caméra:", error);
    });
    
    // Ajouter des écouteurs à l'élément vidéo pour suivre l'état
    video.onpause = () => {
      console.log('GazeTech: Vidéo en pause, tentative de redémarrage');
      video.play().catch(e => console.error('Échec de redémarrage vidéo', e));
    };
    
    // Ajouter un écouteur d'événement pour les pistes se terminant
    webcamStream.getTracks().forEach(track => {
      track.onended = () => {
        console.log('GazeTech: Piste de caméra terminée, tentative de restauration');
        if (cameraInitialized) {
          cameraInitialized = false;
          restoreCamera(true);
        }
      };
    });
    
    // Charger le modèle de maillage facial si disponible
    if (window.facemesh) {
      try {
        faceMesh = await facemesh.load({
          maxFaces: 1,
          refineLandmarks: true,
          detectionConfidence: 0.9,  // Augmenté pour une meilleure précision
          predictIrises: true  // Meilleur suivi des yeux en incluant la prédiction de l'iris
        });
        
        // Démarrer la boucle de suivi
        requestAnimationFrame(trackFace);
        console.log('GazeTech: Suivi du visage initialisé');
        
        if (debugIndicator) {
          debugIndicator.textContent = "Suivi du visage actif";
          debugIndicator.style.display = "block";
        }
      } catch (error) {
        console.error('GazeTech: Échec de chargement du maillage facial:', error);
        if (debugIndicator) {
          debugIndicator.textContent = "Échec du chargement du suivi du visage";
          debugIndicator.style.backgroundColor = "rgba(255, 0, 0, 0.7)";
          debugIndicator.style.display = "block";
        }
      }
    } else {
      // Chargement du modèle de secours
      console.log('GazeTech: Attente du chargement de facemesh...');
      if (debugIndicator) {
        debugIndicator.textContent = "Attente du chargement du suivi du visage...";
        debugIndicator.style.display = "block";
      }
      
      // Essayer de vérifier facemesh périodiquement
      let checkForFacemeshInterval = setInterval(() => {
        if (window.facemesh) {
          clearInterval(checkForFacemeshInterval);
          facemesh.load({
            maxFaces: 1,
            refineLandmarks: true,
            detectionConfidence: 0.9,
            predictIrises: true
          }).then(model => {
            faceMesh = model;
            requestAnimationFrame(trackFace);
            console.log('GazeTech: Suivi du visage initialisé (différé)');
            
            if (debugIndicator) {
              debugIndicator.textContent = "Suivi du visage actif";
            }
          }).catch(error => {
            console.error('GazeTech: Échec de chargement du maillage facial (différé):', error);
          });
        }
      }, 500);
    }
    
    // Traiter toutes les demandes de restauration en file d'attente
    if (cameraRestorationQueue.length > 0) {
      cameraRestorationQueue = []; // Effacer la file d'attente
    }
  } catch (error) {
    console.error('GazeTech: Erreur d\'initialisation webcam:', error);
    cameraInitialized = false;
    cameraRestorationInProgress = false;
    
    // Vérifier si l'erreur est une erreur de permission
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError' || 
        error.message.includes('Permission') || error.message.includes('permission')) {
      console.error('GazeTech: Permission caméra refusée');
      permissionDenied = true;
      showCameraPermissionError(true);
    }
    
    // Mettre à jour l'indicateur de débogage
    const debugIndicator = document.getElementById('gazetech-debug');
    if (debugIndicator) {
      debugIndicator.textContent = "Erreur de caméra: " + error.message;
      debugIndicator.style.backgroundColor = "rgba(255, 0, 0, 0.7)";
      debugIndicator.style.display = "block";
    }
    
    // Mettre à jour l'indicateur d'état
    updateStatusIndicator(false);
    
    // Afficher une notification
    showNotification("Erreur caméra: " + error.message, "error");
    
    // Notifier l'échec
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: false
    }).catch(() => {});
    
    // Réessayer plus tard si la persistance forcée est activée
    if (forceCameraPersistence || justCalibrated) {
      setTimeout(() => {
        restoreCamera(true);
      }, 1500); // Légèrement plus court pour une récupération plus rapide
    }
    
    // Traiter toutes les demandes de restauration en file d'attente
    if (cameraRestorationQueue.length > 0) {
      const oldestRequest = cameraRestorationQueue.shift();
      // Si la demande est récente, réessayer
      if (Date.now() - oldestRequest < 5000) {
        console.log('Réessai d\'initialisation de la caméra à partir de la file d\'attente');
        setTimeout(() => {
          restoreCamera(true);
        }, 1000);
      }
    }
  }
}

// Fonction de suivi principale - complètement révisée pour une meilleure réactivité
async function trackFace() {
  if (!isActive || !faceMesh) {
    requestAnimationFrame(trackFace);
    return;
  }

  try {
    // Vérifier si la vidéo est en cours de lecture et prête
    if (!video.videoWidth || !video.videoHeight || video.paused) {
      if (debugMode) {
        console.log('Vidéo pas encore prête ou en pause, réessai...');
        updateStatusIndicator(false);
      }
      requestAnimationFrame(trackFace);
      return;
    }

    // Traiter l'image vidéo avec un seuil de confiance plus élevé
    const predictions = await faceMesh.estimateFaces({
      input: video,
      flipHorizontal: false,
      predictIrises: true
    });
    
    if (predictions.length > 0) {
      updateStatusIndicator(true);
      const face = predictions[0];
      
      // Traiter les données des yeux avec un suivi amélioré
      const eyeData = processEyeData(face);
      
      // Débogage - afficher la position dans l'élément de débogage
      updateDebugInfo(eyeData.gazePoint.x, eyeData.gazePoint.y, eyeData.confidence);
      
      // Mettre à jour la position du curseur en fonction du regard
      if (settings.gazeCursor) {
        updateCursorPosition(eyeData.gazePoint);
      }
      
      // Vérifier le clin d'œil pour cliquer
      if (settings.blinkClick) {
        handleBlinkClicks(eyeData.isBlinking);
      }
      
      // Gérer le zoom automatique
      if (settings.autoZoom) {
        handleAutoZoom(eyeData.gazePoint);
      }
      
      // Gérer la synthèse vocale
      if (settings.textSpeech) {
        handleTextToSpeech(eyeData.gazePoint);
      }
      
      // Gérer la navigation en regardant les bords de l'écran
      if (settings.edgeNavigation) {
        handleEdgeNavigation(eyeData.gazePoint);
      }
      
      // Gérer le défilement automatique
      if (settings.autoScroll) {
        handleAutoScroll(eyeData.gazePoint);
      }
    } else {
      if (debugMode) {
        console.log('Aucun visage détecté');
        const debugIndicator = document.getElementById('gazetech-debug');
        if (debugIndicator && Math.random() < 0.1) { 
          debugIndicator.textContent = "Aucun visage détecté";
          debugIndicator.style.display = "block";
        }
        updateStatusIndicator(false);
      }
    }
  } catch (error) {
    console.error('GazeTech: Erreur de suivi du visage:', error);
    updateStatusIndicator(false);
  }
  
  // Continuer la boucle de suivi
  requestAnimationFrame(trackFace);
}

// Mettre à jour les informations de débogage avec plus de détails
function updateDebugInfo(x, y, confidence) {
  if (!debugMode) return;
  
  const debugIndicator = document.getElementById('gazetech-debug');
  if (debugIndicator && Math.random() < 0.05) { // Ne mettre à jour qu'occasionnellement
    debugIndicator.style.display = "block";
    debugIndicator.textContent = `Regard: ${Math.round(x)},${Math.round(y)} | Sens: ${eyeMovementSensitivity} | Conf: ${confidence.toFixed(2)}`;
  }
}

// Traiter les données des yeux pour déterminer le point de regard et l'état de clin d'œil - COMPLÈTEMENT RÉVISÉ
function processEyeData(face) {
  // Obtenir les points de repère du visage
  const landmarks = face.scaledMesh;
  
  // Utiliser des points de repère plus spécifiques pour un meilleur suivi des yeux
  // Ces indices correspondent aux points de repère de MediaPipe Face Mesh
  const rightEyeUpper = landmarks[159]; 
  const rightEyeLower = landmarks[145];
  const leftEyeUpper = landmarks[386];
  const leftEyeLower = landmarks[374];
  const rightEyeOuterCorner = landmarks[33];
  const rightEyeInnerCorner = landmarks[133];
  const leftEyeOuterCorner = landmarks[263];
  const leftEyeInnerCorner = landmarks[362];
  const rightIris = landmarks[473]; // Point d'iris plus précis
  const leftIris = landmarks[468];  // Point d'iris plus précis
  const noseTip = landmarks[1];
  const foreheadCenter = landmarks[10];
  
  // Calculer la pose de la tête plus précisément
  const rightEyeCenter = {
    x: (rightEyeInnerCorner[0] + rightEyeOuterCorner[0]) / 2,
    y: (rightEyeUpper[1] + rightEyeLower[1]) / 2
  };
  
  const leftEyeCenter = {
    x: (leftEyeInnerCorner[0] + leftEyeOuterCorner[0]) / 2,
    y: (leftEyeUpper[1] + leftEyeLower[1]) / 2
  };
  
  // Calculer la taille du visage pour la normalisation
  const faceWidth = Math.sqrt(
    Math.pow(landmarks[454][0] - landmarks[234][0], 2) +
    Math.pow(landmarks[454][1] - landmarks[234][1], 2)
  );
  
  // Calculer l'ouverture des yeux pour la détection des clins d'œil (normalisée par la largeur du visage)
  const rightEyeHeight = Math.abs(rightEyeUpper[1] - rightEyeLower[1]) / faceWidth;
  const leftEyeHeight = Math.abs(leftEyeUpper[1] - leftEyeLower[1]) / faceWidth;
  const eyeOpenness = (rightEyeHeight + leftEyeHeight) / 2;
  
  // Détection de clin d'œil plus précise avec seuil ajusté par sensibilité
  const blinkThreshold = 0.012 - (0.0005 * (eyeMovementSensitivity - 5));
  const isBlinking = eyeOpenness < blinkThreshold;
  
  // Calculer le vecteur de regard en utilisant les positions d'iris relatives aux coins des yeux pour une meilleure précision
  const rightEyeWidth = Math.abs(rightEyeOuterCorner[0] - rightEyeInnerCorner[0]);
  const leftEyeWidth = Math.abs(leftEyeOuterCorner[0] - leftEyeInnerCorner[0]);
  
  // Calculer la position de l'iris dans la cavité oculaire
  const rightIrisPosition = {
    x: (rightIris[0] - rightEyeInnerCorner[0]) / rightEyeWidth - 0.5,
    y: (rightIris[1] - ((rightEyeUpper[1] + rightEyeLower[1]) / 2)) / (rightEyeHeight * faceWidth)
  };
  
  const leftIrisPosition = {
    x: (leftIris[0] - leftEyeInnerCorner[0]) / leftEyeWidth - 0.5,
    y: (leftIris[1] - ((leftEyeUpper[1] + leftEyeLower[1]) / 2)) / (leftEyeHeight * faceWidth)
  };
  
  // Combiner les positions d'iris avec pondération en faveur de l'œil droit
  // Car souvent l'œil droit offre un meilleur suivi
  const combinedIrisX = (rightIrisPosition.x * 0.6 + leftIrisPosition.x * 0.4);
  const combinedIrisY = (rightIrisPosition.y * 0.5 + leftIrisPosition.y * 0.5);
  
  // Calculer la position de la tête
  let headX = (((rightEyeCenter.x + leftEyeCenter.x) / 2) - (video.width / 2)) / (video.width / 3);
  let headY = (((rightEyeCenter.y + leftEyeCenter.y) / 2) - (video.height / 2)) / (video.height / 3);
  
  // Algorithme amélioré qui combine la position de la tête et la position de l'iris
  // La position de l'iris est pondérée plus fortement pour un curseur plus réactif
  const gazeX = headX * 0.2 + combinedIrisX * 4.0;
  const gazeY = headY * 0.2 + combinedIrisY * 4.0;
  
  // Appliquer la calibration si disponible
  let calibratedX = gazeX;
  let calibratedY = gazeY;
  
  if (calibrationData && calibrationData.length >= 5) {
    // Utiliser les données de calibration pour normaliser le point de regard
    // Correction de calibration simple (dans une implémentation réelle, ce serait plus sophistiqué)
    const centerCalibration = calibrationData[0];
    if (centerCalibration && centerCalibration.eyeData) {
      // Appliquer des décalages basés sur le point central de calibration
      calibratedX = gazeX - (centerCalibration.eyeData.x / 80);  // Augmenté la sensibilité
      calibratedY = gazeY - (centerCalibration.eyeData.y / 80);
    }
  }
  
  // Appliquer l'amplification basée sur la sensibilité (mise à l'échelle non linéaire pour un meilleur contrôle)
  const sensitivityFactor = Math.pow(eyeMovementSensitivity / 5, 2.0); // Non-linéarité augmentée (était 1.7)
  const amplifiedX = calibratedX * (headTracking.xScale * sensitivityFactor);
  const amplifiedY = calibratedY * (headTracking.yScale * sensitivityFactor);
  
  // Mappage non linéaire amélioré pour une meilleure précision
  // Utilisation d'une fonction d'ordre supérieur (septième puissance) pour encore plus de précision
  const screenX = window.innerWidth * (0.5 + Math.pow(amplifiedX, 7) * 0.009);
  const screenY = window.innerHeight * (0.5 + Math.pow(amplifiedY, 7) * 0.009);
  
  // Calculer le score de confiance (0-1) basé sur la visibilité du visage et la stabilité
  const confidence = Math.min(1, faceWidth / (video.width * 0.4));
  
  // Appliquer un lissage réduit pour un curseur plus réactif
  // Lissage inférieur (plus réactif) lorsque la confiance est élevée et pour des mouvements plus grands
  const movementMagnitude = Math.sqrt(
    Math.pow(screenX - lastGazePoint.x, 2) + 
    Math.pow(screenY - lastGazePoint.y, 2)
  ) / Math.sqrt(Math.pow(window.innerWidth, 2) + Math.pow(window.innerHeight, 2));
  
  // Réduire adaptativement le lissage pour des mouvements plus grands ou lorsque la confiance est élevée
  const adaptiveSmoothing = Math.max(
    0.01,  // lissage minimum (réactivité maximale) - réduit de 0.02
    headTracking.smoothFactor * (1 - confidence * 0.7) * (1 - movementMagnitude * 3)
  );
  
  // Pour les petits mouvements précis, utiliser un lissage encore plus faible
  const precisionScalingFactor = Math.min(1.0, movementMagnitude * 20); 
  const finalSmoothing = adaptiveSmoothing * precisionScalingFactor;
  
  // Appliquer le lissage
  const smoothedX = lastGazePoint.x * finalSmoothing + screenX * (1 - finalSmoothing);
  const smoothedY = lastGazePoint.y * finalSmoothing + screenY * (1 - finalSmoothing);
  
  // Contraindre aux limites de l'écran avec une petite marge
  const gazePoint = { 
    x: Math.max(10, Math.min(window.innerWidth - 10, smoothedX)),
    y: Math.max(10, Math.min(window.innerHeight - 10, smoothedY))
  };
  
  // Mettre à jour le dernier point de regard
  lastGazePoint = gazePoint;
  
  return {
    gazePoint,
    isBlinking,
    confidence
  };
}

// Mettre à jour la position du curseur en fonction du point de regard avec une animation fluide
function updateCursorPosition(gazePoint) {
  if (cursor) {
    // Appliquer un positionnement direct pour une réponse immédiate
    cursor.style.transform = `translate(${gazePoint.x}px, ${gazePoint.y}px) translate(-50%, -50%)`;
    
    // Ajouter un retour visuel subtil pour le mouvement
    const movementMagnitude = Math.sqrt(
      Math.pow(gazePoint.x - parseFloat(cursor.dataset.lastX || gazePoint.x), 2) + 
      Math.pow(gazePoint.y - parseFloat(cursor.dataset.lastY || gazePoint.y), 2)
    );
    
    // Stocker la dernière position
    cursor.dataset.lastX = gazePoint.x;
    cursor.dataset.lastY = gazePoint.y;
    
    // Retour visuel sur mouvement significatif
    if (movementMagnitude > 20) { // Seuil réduit pour des retours visuels plus fréquents
      cursor.style.transform += ' scale(1.3)';
      setTimeout(() => {
        cursor.style.transform = `translate(${gazePoint.x}px, ${gazePoint.y}px) translate(-50%, -50%)`;
      }, 70); // Réinitialisation plus rapide (était 100ms)
    }
  }
}

// Gérer la détection des clins d'œil pour cliquer
function handleBlinkClicks(isBlinking) {
  if (isBlinking && !lastEyeState.isBlinking) {
    // Le clin d'œil vient de commencer
    const now = Date.now();
    
    if (now - lastEyeState.lastBlinkTime < settings.blinkDelay) {
      // Double clin d'œil détecté
      simulateDoubleClick(lastGazePoint);
    } else {
      // Clin d'œil simple
      simulateClick(lastGazePoint);
    }
    
    lastEyeState.lastBlinkTime = now;
  }
  
  lastEyeState.isBlinking = isBlinking;
}

// Simuler un clic de souris au point de regard
function simulateClick(point) {
  // Mettre en évidence le curseur brièvement pour montrer un clic
  cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.9)';
  setTimeout(() => {
    cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.6)';
  }, 200);
  
  // Trouver l'élément au point de regard
  const element = document.elementFromPoint(point.x, point.y);
  
  if (element) {
    // Créer et distribuer des événements de clic
    const clickEvent = new MouseEvent('click', {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y
    });
    
    element.dispatchEvent(clickEvent);
  }
}

// Simuler un double clic au point de regard
function simulateDoubleClick(point) {
  // Mettre en évidence le curseur pour montrer un double clic
  cursor.style.backgroundColor = 'rgba(44, 123, 229, 1.0)';
  setTimeout(() => {
    cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.6)';
  }, 300);
  
  // Trouver l'élément au point de regard
  const element = document.elementFromPoint(point.x, point.y);
  
  if (element) {
    // Créer et distribuer des événements de double clic
    const dblClickEvent = new MouseEvent('dblclick', {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y
    });
    
    element.dispatchEvent(dblClickEvent);
  }
}

// Gérer le zoom automatique lorsque le regard est fixé sur un élément
function handleAutoZoom(gazePoint) {
  const now = Date.now();
  
  // Trouver l'élément au point de regard
  const element = document.elementFromPoint(gazePoint.x, gazePoint.y);
  
  if (element) {
    // Si on regarde toujours le même élément pendant le délai de zoom
    if (element === lastZoomElement && now - lastGazeTime > settings.zoomDelay * 1000) {
      // Appliquer l'effet de zoom
      if (!element.hasAttribute('data-gazetech-zoomed')) {
        // Vérifier si l'élément est une image
        if (element.tagName === 'IMG') {
          element.setAttribute('data-gazetech-zoomed', 'true');
          
          // Stocker les styles originaux
          const originalStyle = {
            transform: element.style.transform,
            transition: element.style.transition,
            zIndex: element.style.zIndex
          };
          
          element.setAttribute('data-original-style', JSON.stringify(originalStyle));
          
          // Appliquer l'effet de zoom
          element.style.transition = 'transform 0.3s ease-out';
          element.style.transform = 'scale(1.5)';
          element.style.zIndex = '9999';
          
          // Réinitialiser le zoom après avoir détourné le regard
          setTimeout(() => {
            if (element.hasAttribute('data-gazetech-zoomed')) {
              const lookingAway = document.elementFromPoint(gazePoint.x, gazePoint.y) !== element;
              if (lookingAway) {
                resetZoom(element);
              } else {
                // Vérifier à nouveau plus tard
                const checkInterval = setInterval(() => {
                  const currentElement = document.elementFromPoint(lastGazePoint.x, lastGazePoint.y);
                  if (currentElement !== element) {
                    resetZoom(element);
                    clearInterval(checkInterval);
                  }
                }, 500);
                
                // Timeout de sécurité pour s'assurer qu'on ne laisse pas les éléments zoomés indéfiniment
                setTimeout(() => {
                  clearInterval(checkInterval);
                  resetZoom(element);
                }, 10000);
              }
            }
          }, 3000);
        }
        // Gérer les éléments de texte
        else if (element.tagName === 'P' || element.tagName === 'DIV' || element.tagName === 'SPAN' || 
                element.tagName === 'H1' || element.tagName === 'H2' || element.tagName === 'H3' || 
                element.tagName === 'LI' || element.tagName === 'A') {
          
          element.setAttribute('data-gazetech-zoomed', 'true');
          
          // Stocker les styles originaux
          const originalStyle = {
            fontSize: element.style.fontSize,
            transition: element.style.transition,
            backgroundColor: element.style.backgroundColor
          };
          
          element.setAttribute('data-original-style', JSON.stringify(originalStyle));
          
          // Obtenir la taille de police calculée et l'augmenter
          const computedStyle = window.getComputedStyle(element);
          const currentSize = parseFloat(computedStyle.fontSize);
          
          // Appliquer l'effet de zoom
          element.style.transition = 'font-size 0.3s ease-out, background-color 0.3s ease-out';
          element.style.fontSize = `${currentSize * 1.3}px`;
          element.style.backgroundColor = 'rgba(44, 123, 229, 0.05)';
          
          // Réinitialiser le zoom après avoir détourné le regard
          setTimeout(() => {
            if (element.hasAttribute('data-gazetech-zoomed')) {
              const lookingAway = document.elementFromPoint(gazePoint.x, gazePoint.y) !== element;
              if (lookingAway) {
                resetZoom(element);
              } else {
                // Vérifier à nouveau plus tard
                const checkInterval = setInterval(() => {
                  const currentElement = document.elementFromPoint(lastGazePoint.x, lastGazePoint.y);
                  if (currentElement !== element) {
                    resetZoom(element);
                    clearInterval(checkInterval);
                  }
                }, 500);
                
                // Timeout de sécurité
                setTimeout(() => {
                  clearInterval(checkInterval);
                  resetZoom(element);
                }, 10000);
              }
            }
          }, 5000);
        }
      }
    }
    
    // Mettre à jour le dernier élément zoomé
    lastZoomElement = element;
  } else {
    // Réinitialiser le dernier élément zoomé si on ne regarde rien
    lastZoomElement = null;
  }
  
  // Mettre à jour le dernier temps de regard
  lastGazeTime = now;
}

// Réinitialiser l'effet de zoom sur un élément
function resetZoom(element) {
  if (element && element.hasAttribute('data-gazetech-zoomed')) {
    element.removeAttribute('data-gazetech-zoomed');
    
    // Restaurer les styles originaux
    if (element.hasAttribute('data-original-style')) {
      try {
        const originalStyle = JSON.parse(element.getAttribute('data-original-style'));
        
        // Appliquer les styles originaux
        for (const [key, value] of Object.entries(originalStyle)) {
          element.style[key] = value;
        }
      } catch (e) {
        console.error('Erreur lors de la restauration du style original:', e);
      }
      
      element.removeAttribute('data-original-style');
    }
  }
}

// Gérer la synthèse vocale pour les éléments regardés
function handleTextToSpeech(gazePoint) {
  if (isSpeaking) return; // Ne pas commencer une nouvelle synthèse vocale si déjà en cours
  
  const now = Date.now();
  const element = document.elementFromPoint(gazePoint.x, gazePoint.y);
  
  if (element) {
    // Si on regarde le même élément de texte pendant un moment
    if (element === lastTextElement && now - lastGazeTime > 2000) {
      // Obtenir le contenu textuel
      let textContent = '';
      
      if (element.tagName === 'IMG' && element.alt) {
        textContent = element.alt; // Utiliser le texte alternatif pour les images
      } else if (element.tagName === 'INPUT' && element.value) {
        textContent = element.value; // Utiliser la valeur pour les champs de saisie
      } else if (element.tagName === 'A') {
        textContent = element.textContent || element.innerText || 'Lien'; // Utiliser le texte ou "Lien" pour les liens
      } else {
        textContent = element.textContent || element.innerText || ''; // Utiliser le contenu textuel pour les autres éléments
      }
      
      // Couper et limiter la longueur
      textContent = textContent.trim();
      if (textContent.length > 200) {
        textContent = textContent.substring(0, 197) + '...';
      }
      
      // Synthétiser le texte s'il n'est pas vide
      if (textContent && textContent.length > 1) {
        speakText(textContent);
        
        // Mettre en évidence l'élément
        if (!element.classList.contains('gazetech-highlighted-text')) {
          element.classList.add('gazetech-highlighted-text');
          
          // Supprimer la mise en évidence après la fin de la synthèse vocale
          setTimeout(() => {
            element.classList.remove('gazetech-highlighted-text');
          }, textContent.length * 80); // Estimation approximative de la durée de la synthèse vocale
        }
      }
    }
    
    // Mettre à jour le dernier élément de texte
    lastTextElement = element;
  } else {
    // Réinitialiser le dernier élément de texte si on ne regarde rien
    lastTextElement = null;
  }
}

// Synthétiser la parole à partir du texte
function speakText(text) {
  if (!text || isSpeaking) return;
  
  // Annuler toute synthèse vocale en cours
  speechSynthesis.cancel();
  
  // Créer l'énoncé
  const utterance = new SpeechSynthesisUtterance(text);
  
  // Définir la langue en fonction de la page ou par défaut en anglais
  const pageLang = document.documentElement.lang || 'en';
  utterance.lang = pageLang;
  
  // Définir le débit à partir des paramètres
  utterance.rate = settings.speechRate || 1;
  
  // Définir les gestionnaires d'événements
  utterance.onstart = () => {
    isSpeaking = true;
  };
  
  utterance.onend = () => {
    isSpeaking = false;
  };
  
  utterance.onerror = () => {
    isSpeaking = false;
  };
  
  // Synthétiser
  speechSynthesis.speak(utterance);
}

// Gérer la navigation en regardant les bords de l'écran
function handleEdgeNavigation(gazePoint) {
  const edgeSize = settings.edgeSize || 10; // La taille de bord par défaut est de 10% de l'écran
  const edgeSizePixels = {
    x: window.innerWidth * (edgeSize / 100),
    y: window.innerHeight * (edgeSize / 100)
  };
  
  // Vérifier si on regarde le bord gauche
  if (gazePoint.x < edgeSizePixels.x) {
    showEdgeIndicator('left');
    
    // Si on regarde le bord pendant plus d'une seconde, naviguer en arrière
    if (Date.now() - lastGazeTime > 1000) {
      window.history.back();
      lastGazeTime = Date.now(); // Réinitialiser pour éviter les navigations multiples
    }
  }
  // Vérifier si on regarde le bord droit
  else if (gazePoint.x > window.innerWidth - edgeSizePixels.x) {
    showEdgeIndicator('right');
    
    // Si on regarde le bord pendant plus d'une seconde, naviguer en avant
    if (Date.now() - lastGazeTime > 1000) {
      window.history.forward();
      lastGazeTime = Date.now(); // Réinitialiser pour éviter les navigations multiples
    }
  }
  // Vérifier si on regarde le bord inférieur pour le défilement
  else if (gazePoint.y > window.innerHeight - edgeSizePixels.y) {
    showEdgeIndicator('bottom');
  }
  else {
    hideEdgeIndicators();
  }
}

// Afficher l'indicateur de bord
function showEdgeIndicator(edge) {
  // Créer ou obtenir les indicateurs de bord
  let leftEdge = document.getElementById('gazetech-edge-left');
  let rightEdge = document.getElementById('gazetech-edge-right');
  let bottomEdge = document.getElementById('gazetech-edge-bottom');
  
  if (!leftEdge) {
    leftEdge = document.createElement('div');
    leftEdge.id = 'gazetech-edge-left';
    leftEdge.className = 'gazetech-edge-left';
    document.body.appendChild(leftEdge);
  }
  
  if (!rightEdge) {
    rightEdge = document.createElement('div');
    rightEdge.id = 'gazetech-edge-right';
    rightEdge.className = 'gazetech-edge-right';
    document.body.appendChild(rightEdge);
  }
  
  if (!bottomEdge) {
    bottomEdge = document.createElement('div');
    bottomEdge.id = 'gazetech-edge-bottom';
    bottomEdge.className = 'gazetech-edge-bottom';
    document.body.appendChild(bottomEdge);
  }
  
  // Activer le bord approprié
  leftEdge.classList.toggle('gazetech-edge-active', edge === 'left');
  rightEdge.classList.toggle('gazetech-edge-active', edge === 'right');
  bottomEdge.classList.toggle('gazetech-edge-active', edge === 'bottom');
}

// Masquer tous les indicateurs de bord
function hideEdgeIndicators() {
  const edges = document.querySelectorAll('.gazetech-edge-left, .gazetech-edge-right, .gazetech-edge-bottom');
  edges.forEach(edge => {
    edge.classList.remove('gazetech-edge-active');
  });
}

// Gérer le défilement automatique en fonction de la position du regard
function handleAutoScroll(gazePoint) {
  if (!settings.autoScroll) return;
  
  const edgeSize = settings.edgeSize || 10; // La taille de bord par défaut est de 10% de l'écran
  const edgeSizePixels = {
    y: window.innerHeight * (edgeSize / 100)
  };
  
  // Vérifier si on regarde le bord inférieur
  if (gazePoint.y > window.innerHeight - edgeSizePixels.y) {
    // Commencer à défiler vers le bas si pas déjà en train de défiler
    if (!isScrolling) {
      isScrolling = true;
      smoothScroll('down');
    }
  }
  // Vérifier si on regarde le bord supérieur
  else if (gazePoint.y < edgeSizePixels.y) {
    // Commencer à défiler vers le haut si pas déjà en train de défiler
    if (!isScrolling) {
      isScrolling = true;
      smoothScroll('up');
    }
  }
  else {
    // Arrêter le défilement
    isScrolling = false;
  }
}

// Fonction de défilement fluide
function smoothScroll(direction) {
  if (!isScrolling) return;
  
  const scrollSpeed = settings.scrollSpeed || 5;
  const scrollAmount = direction === 'down' ? scrollSpeed : -scrollSpeed;
  
  // Faire défiler la page
  window.scrollBy({
    top: scrollAmount,
    behavior: 'auto' // Utiliser 'auto' pour un défilement continu plus fluide
  });
  
  // Continuer à défiler si on regarde toujours le bord
  requestAnimationFrame(() => {
    if (isScrolling) {
      smoothScroll(direction);
    }
  });
}

// Initialiser lorsque le document est chargé
document.addEventListener('DOMContentLoaded', async function() {
  try {
    console.log("GazeTech: Script de contenu chargé");
    
    // Charger d'abord les paramètres
    await loadSettings();
    
    // Initialiser l'interface utilisateur
    initializeUI();
    
    // Démarrer le heartbeat immédiatement
    startHeartbeat();
    
    // Vérifier si nous devrions restaurer la caméra
    chrome.runtime.sendMessage({
      action: 'checkCameraStatus',
      forceCheck: true
    }).then(response => {
      console.log("Vérification initiale de la caméra:", response);
      if (response && (response.shouldActivate || response.forceRestore)) {
        // Initialiser le suivi immédiatement
        initializeTracking(true);
      }
    }).catch(error => {
      console.log("Erreur de vérification initiale de la caméra:", error);
      // Essayer d'initialiser la caméra de toute façon
      initializeTracking(true);
    });
    
    // Ajouter des écouteurs de messages
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'startEyeTracking') {
        console.log("Démarrage du suivi oculaire avec données de calibration:", request.calibrationData);
        
        // Stocker les données de calibration
        calibrationData = request.calibrationData;
        justCalibrated = true;
        forceCameraPersistence = true;
        
        // Mettre à jour les paramètres si fournis
        if (request.settings) {
          settings = { ...settings, ...request.settings };
          
          // Appliquer la sensibilité du mouvement des yeux
          if (settings.gazeSensitivity) {
            eyeMovementSensitivity = settings.gazeSensitivity + 2; // +2 pour plus de réactivité
            headTracking.xScale = 3.0 + (eyeMovementSensitivity * 0.8);
            headTracking.yScale = 3.0 + (eyeMovementSensitivity * 0.8);
            headTracking.smoothFactor = Math.max(0.01, 0.15 - (eyeMovementSensitivity * 0.02));
          }
        }
        
        // Forcer l'initialisation de la caméra si ce n'est pas déjà fait
        if (!cameraInitialized) {
          initializeTracking(true);
        }
        
        // Mettre à jour le statut
        isActive = true;
        isCalibrated = true;
        
        // Définir l'indicateur d'achèvement de calibration
        justCalibrated = true;
        
        // Stocker la calibration dans le stockage
        chrome.storage.sync.set({
          calibrated: true,
          calibrationData: calibrationData
        });
        
        // Notifier le script de fond que la calibration est terminée
        chrome.runtime.sendMessage({
          action: 'calibrationCompleted',
          calibrationData: calibrationData
        }).catch(() => {});
        
        // Afficher une notification
        showNotification("Calibration terminée, suivi des yeux actif");
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'tabFocus') {
        console.log('Onglet a reçu une notification de focus:', request);
        tabInFocus = true;
        
        // Restaurer la caméra si nécessaire
        if (request.shouldRestoreCamera || request.forceActivate) {
          restoreCamera(request.forceActivate || true); // Forcé par défaut
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'tabBlur') {
        console.log('L\'onglet perd le focus mais garde la caméra en vie');
        tabInFocus = false;
        
        // Garder la caméra allumée malgré la perte de focus de l'onglet si nécessaire
        if (request.keepCameraAlive || forceCameraPersistence) {
          forceKeepCameraOn = true;
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'forceActivateCamera') {
        console.log('Activation forcée de la caméra demandée');
        forceKeepCameraOn = true;
        forceCameraPersistence = true;
        restoreCamera(true);
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'syncCameraState') {
        if (request.shouldBeActive && !cameraInitialized) {
          console.log('Sync: La caméra devrait être active mais ne l\'est pas, restauration');
          forceKeepCameraOn = true;
          restoreCamera(true);
        }
        
        // Mettre à jour l'indicateur de persistance
        if (request.forcePersistence) {
          forceCameraPersistence = true;
          forceKeepCameraOn = true;
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'maintainCamera') {
        console.log('Demande de maintien de caméra reçue');
        
        // Mettre à jour les indicateurs de persistance
        if (request.forcePersistence) {
          forceCameraPersistence = true;
          forceKeepCameraOn = true;
        }
        
        // Forcer la restauration de la caméra si nous venons de terminer la calibration
        if (request.afterCalibration) {
          justCalibrated = true;
        }
        
        // Restaurer la caméra si non active
        if (!cameraInitialized) {
          restoreCamera(true);
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      sendResponse({ success: false });
      return true;
    });
    
    // Ajouter des écouteurs pour les changements de visibilité
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // La page est cachée (l'utilisateur a changé d'onglet)
        console.log('Page cachée, maintenir la caméra si la persistance est activée');
        tabInFocus = false;
      } else {
        // La page est visible
        console.log('Page visible, restauration de la caméra si nécessaire');
        tabInFocus = true;
        
        // Restaurer la caméra si nécessaire
        if (!cameraInitialized && (forceKeepCameraOn || forceCameraPersistence)) {
          restoreCamera(true);
        }
      }
    });
    
    // Ajouter des écouteurs pour le focus/perte de focus de la fenêtre
    window.addEventListener('focus', () => {
      console.log('La fenêtre a gagné le focus');
      tabInFocus = true;
      
      // Notifier le script de fond
      chrome.runtime.sendMessage({
        action: 'tabFocused',
      }).catch(() => {});
      
      // Restaurer la caméra si nécessaire
      if (!cameraInitialized && (forceKeepCameraOn || forceCameraPersistence)) {
        restoreCamera(true);
      }
    });
    
    window.addEventListener('blur', () => {
      console.log('La fenêtre a perdu le focus');
      tabInFocus = false;
      
      // Notifier le script de fond
      chrome.runtime.sendMessage({
        action: 'tabBlurred',
      }).catch(() => {});
    });
    
  } catch (error) {
    console.error("GazeTech: Erreur d'initialisation du script de contenu:", error);
  }
});

// Vérification supplémentaire de l'état de la caméra à intervalles réguliers
setInterval(() => {
  if (isActive && !cameraInitialized && (forceCameraPersistence || justCalibrated)) {
    console.log("Vérification périodique de la caméra: la caméra devrait être active mais ne l'est pas");
    restoreCamera(true);
  }
}, 3000);

// Vérification agressive de l'état de la caméra après un changement d'onglet récent
const checkForTabSwitchRestore = () => {
  // Vérifier si le document est visible maintenant (peut avoir été caché)
  if (!document.hidden && forceCameraPersistence) {
    console.log("Verification post-changement d'onglet");
    if (!cameraInitialized) {
      restoreCamera(true);
    }
  }
};

// Vérifie peu après que la page redevient visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Faire plusieurs tentatives à différents délais
    [10, 100, 300, 600, 1000, 2000].forEach(delay => {
      setTimeout(checkForTabSwitchRestore, delay);
    });
  }
});

// Initialiser si le document est déjà chargé
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  console.log("Document déjà chargé, initialisation");
  setTimeout(() => {
    loadSettings().then(() => {
      initializeUI();
      startHeartbeat();
      
      // Vérifier si nous devrions initialiser la caméra
      chrome.runtime.sendMessage({
        action: 'checkCameraStatus',
        forceCheck: true
      }).then(response => {
        if (response && (response.shouldActivate || response.forceRestore)) {
          initializeTracking(true);
        }
      }).catch(error => {
        console.log("Erreur de vérification initiale de la caméra:", error);
        // Essayer d'initialiser la caméra de toute façon pour plus de robustesse
        setTimeout(() => initializeTracking(true), 500);
      });
    });
  }, 100);
}

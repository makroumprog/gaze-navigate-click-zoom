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
let eyeMovementSensitivity = 3; // Sensibilité des mouvements oculaires (ajustable)

// Load settings from storage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      settings = items;
      isActive = settings.isActive;
      isCalibrated = settings.calibrated;
      calibrationData = settings.calibrationData;
      
      // Appliquer la sensibilité des mouvements oculaires depuis les paramètres
      if (settings.gazeSensitivity) {
        eyeMovementSensitivity = settings.gazeSensitivity;
      }
      
      resolve(settings);
    });
  });
}

// Initialize UI elements
function initializeUI() {
  // Create cursor element
  cursor = document.createElement('div');
  cursor.id = 'gazetech-cursor';
  cursor.style.cssText = `
    position: fixed;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background-color: rgba(44, 123, 229, 0.5);
    border: 2px solid rgba(44, 123, 229, 0.8);
    pointer-events: none;
    z-index: 999999;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 10px rgba(44, 123, 229, 0.5);
    display: ${isActive ? 'block' : 'none'};
    transition: background-color 0.2s, opacity 0.2s;
  `;
  document.body.appendChild(cursor);

  // Create webcam video element (hidden)
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
  document.body.appendChild(video);

  // Create canvas for processing (hidden)
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
}

// Initialize webcam and face tracking
async function initializeTracking() {
  try {
    // Access webcam
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }
    });
    
    video.srcObject = webcamStream;
    await video.play();
    
    // Notifier le background script que la caméra est active
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: true
    });
    
    // Load face mesh model if available
    if (window.facemesh) {
      faceMesh = await facemesh.load({
        maxFaces: 1,
        refineLandmarks: true
      });
      
      // Start tracking loop
      requestAnimationFrame(trackFace);
      console.log('GazeTech: Face tracking initialized');
    } else {
      // Fallback model loading
      console.log('GazeTech: Waiting for facemesh to load...');
      // In a real extension, we would load the facemesh library here
    }
  } catch (error) {
    console.error('GazeTech: Error initializing webcam:', error);
  }
}

// Main tracking function
async function trackFace() {
  if (!isActive || !faceMesh) {
    requestAnimationFrame(trackFace);
    return;
  }

  try {
    // Process video frame
    const predictions = await faceMesh.estimateFaces({
      input: video,
      flipHorizontal: false
    });
    
    if (predictions.length > 0) {
      const face = predictions[0];
      
      // Process eye data
      const eyeData = processEyeData(face);
      
      // Debug - afficher la position du regard dans la console
      console.log('Position du regard:', eyeData.gazePoint.x, eyeData.gazePoint.y);
      
      // Update cursor position based on gaze
      if (settings.gazeCursor) {
        updateCursorPosition(eyeData.gazePoint);
      }
      
      // Check for blink to click
      if (settings.blinkClick) {
        handleBlinkClicks(eyeData.isBlinking);
      }
      
      // Handle auto zoom
      if (settings.autoZoom) {
        handleAutoZoom(eyeData.gazePoint);
      }
      
      // Handle text to speech
      if (settings.textSpeech) {
        handleTextToSpeech(eyeData.gazePoint);
      }
      
      // Handle navigation by looking at screen edges
      if (settings.edgeNavigation) {
        handleEdgeNavigation(eyeData.gazePoint);
      }
      
      // Handle auto scrolling
      if (settings.autoScroll) {
        handleAutoScroll(eyeData.gazePoint);
      }
    }
  } catch (error) {
    console.error('GazeTech: Error tracking face:', error);
  }
  
  // Continue tracking loop
  requestAnimationFrame(trackFace);
}

// Process eye data to determine gaze point and blink state
function processEyeData(face) {
  // In a real implementation, this would use the actual eye landmarks
  // from the facemesh model to determine gaze direction
  
  // For this demo, we'll simulate eye tracking using head position as a proxy
  // and map it to screen coordinates
  
  // In actual implementation, this would use much more sophisticated algorithms
  // analyzing the iris position relative to the eye corners
  
  // Get face position and landmarks
  const landmarks = face.scaledMesh;
  
  // Calculate gaze point (simplified for demo)
  // In a real implementation, we would use iris tracking and gaze estimation
  // For now, we'll just map head position to screen
  
  // Get nose tip as reference point (landmark #1)
  const nose = landmarks[1];
  
  // Map nose position to screen coordinates with sensitivity adjustment
  // Augmenter l'impact de la sensibilité
  const sensitivity = eyeMovementSensitivity * 0.5; // Range 0.5 - 5
  
  // Calculate relative position in video frame
  const relativeX = nose[0] / video.width;
  const relativeY = nose[1] / video.height;
  
  // Apply non-linear mapping for more precise control in center area
  // Utilisation d'un mappage plus sensible pour détecter de plus petits mouvements
  const mappedX = Math.pow(relativeX - 0.5, sensitivity > 3 ? 1 : 3) * sensitivity * 5 + 0.5;
  const mappedY = Math.pow(relativeY - 0.5, sensitivity > 3 ? 1 : 3) * sensitivity * 5 + 0.5;
  
  // Map to screen coordinates with some smoothing
  const gazeX = window.innerWidth * mappedX;
  const gazeY = window.innerHeight * mappedY;
  
  // Apply smoothing with previous position (ajustement de la fluidité)
  // Moins de lissage pour des mouvements plus réactifs
  const smoothFactor = 0.7; // Réduit par rapport à 0.8 précédent
  const smoothedX = lastGazePoint.x * smoothFactor + gazeX * (1 - smoothFactor);
  const smoothedY = lastGazePoint.y * smoothFactor + gazeY * (1 - smoothFactor);
  
  // Detect blinking (simplified for demo)
  // In a real implementation, we would measure eye aspect ratio using landmarks
  
  // Simulate blink detection 
  // (in real implementation, we would use eye landmarks to calculate eye openness)
  // Augmenter légèrement la fréquence des clignements pour le test
  const isBlinking = Math.random() < 0.02; // A bit higher than 0.01 for testing
  
  const gazePoint = { x: smoothedX, y: smoothedY };
  lastGazePoint = gazePoint;
  
  return {
    gazePoint,
    isBlinking
  };
}

// Update cursor position based on gaze point
function updateCursorPosition(gazePoint) {
  if (cursor) {
    cursor.style.left = `${gazePoint.x}px`;
    cursor.style.top = `${gazePoint.y}px`;
  }
}

// Handle blink detection for clicking
function handleBlinkClicks(isBlinking) {
  if (isBlinking && !lastEyeState.isBlinking) {
    // Blink just started
    const now = Date.now();
    
    if (now - lastEyeState.lastBlinkTime < settings.blinkDelay) {
      // Double blink detected
      simulateDoubleClick(lastGazePoint);
    } else {
      // Single blink
      simulateClick(lastGazePoint);
    }
    
    lastEyeState.lastBlinkTime = now;
  }
  
  lastEyeState.isBlinking = isBlinking;
}

// Simulate a mouse click at the gaze point
function simulateClick(point) {
  // Highlight the cursor briefly to show a click
  cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.9)';
  setTimeout(() => {
    cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.5)';
  }, 200);
  
  // Find the element at the gaze point
  const element = document.elementFromPoint(point.x, point.y);
  
  if (element) {
    // Create and dispatch click events
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

// Simulate a double click at the gaze point
function simulateDoubleClick(point) {
  // Highlight the cursor to show a double click
  cursor.style.backgroundColor = 'rgba(44, 123, 229, 1.0)';
  setTimeout(() => {
    cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.5)';
  }, 300);
  
  // Find the element at the gaze point
  const element = document.elementFromPoint(point.x, point.y);
  
  if (element) {
    // Create and dispatch double click events
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

// Handle auto zoom when gaze is fixed on an element
function handleAutoZoom(gazePoint) {
  const now = Date.now();
  
  // Find element at gaze point
  const element = document.elementFromPoint(gazePoint.x, gazePoint.y);
  
  if (element) {
    // If still looking at the same element for zoom delay time
    if (element === lastZoomElement && now - lastGazeTime > settings.zoomDelay * 1000) {
      // Apply zoom effect
      if (!element.hasAttribute('data-gazetech-zoomed')) {
        // Check if element is an image
        if (element.tagName === 'IMG') {
          element.setAttribute('data-gazetech-zoomed', 'true');
          
          // Store original styles
          const originalStyle = {
            transform: element.style.transform,
            transition: element.style.transition,
            zIndex: element.style.zIndex
          };
          
          element.setAttribute('data-original-style', JSON.stringify(originalStyle));
          
          // Apply zoom effect
          element.style.transition = 'transform 0.3s ease-in-out';
          element.style.transform = 'scale(1.5)';
          element.style.zIndex = '9999';
          
          // Remove zoom effect after 5 seconds or when user looks away
          setTimeout(() => {
            if (element.hasAttribute('data-gazetech-zoomed')) {
              removeZoom(element);
            }
          }, 5000);
        }
      }
    }
  } else {
    // Reset if looking at a different element
    removeZoomFromLastElement();
  }
  
  // Update state
  lastZoomElement = element;
  lastGazeTime = now;
}

// Remove zoom effect from element
function removeZoom(element) {
  if (element.hasAttribute('data-original-style')) {
    const originalStyle = JSON.parse(element.getAttribute('data-original-style'));
    
    element.style.transform = originalStyle.transform || '';
    element.style.transition = originalStyle.transition || '';
    element.style.zIndex = originalStyle.zIndex || '';
    
    element.removeAttribute('data-gazetech-zoomed');
    element.removeAttribute('data-original-style');
  }
}

// Remove zoom from last element
function removeZoomFromLastElement() {
  if (lastZoomElement && lastZoomElement.hasAttribute('data-gazetech-zoomed')) {
    removeZoom(lastZoomElement);
  }
}

// Handle text-to-speech for text elements
function handleTextToSpeech(gazePoint) {
  if (isSpeaking) return; // Don't interrupt current speech
  
  const now = Date.now();
  
  // Find element at gaze point
  const element = document.elementFromPoint(gazePoint.x, gazePoint.y);
  
  if (element) {
    // If still looking at the same text element for 2 seconds
    if (element === lastTextElement && now - lastGazeTime > 2000) {
      // Check if element contains readable text
      if (isTextElement(element) && element.textContent.trim().length > 0) {
        speakText(element.textContent.trim());
      }
    }
  }
  
  // Update state
  lastTextElement = element;
}

// Check if element contains readable text
function isTextElement(element) {
  const tagName = element.tagName.toLowerCase();
  const textTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'li', 'a'];
  
  return textTags.includes(tagName);
}

// Use speech synthesis to read text
function speakText(text) {
  if (!speechSynthesis) return;
  
  // Stop any current speech
  speechSynthesis.cancel();
  
  // Create new speech utterance
  const utterance = new SpeechSynthesisUtterance(text);
  
  // Configure speech options
  utterance.rate = settings.speechRate;
  utterance.pitch = 1.0;
  
  // Set events
  utterance.onstart = () => {
    isSpeaking = true;
  };
  
  utterance.onend = () => {
    isSpeaking = false;
  };
  
  utterance.onerror = () => {
    isSpeaking = false;
  };
  
  // Start speaking
  speechSynthesis.speak(utterance);
}

// Handle navigation by looking at screen edges
function handleEdgeNavigation(gazePoint) {
  // Calculate edge zone width/height
  const edgeSize = window.innerWidth * (settings.edgeSize / 100);
  
  // Check if gaze is at edges of screen
  if (gazePoint.x < edgeSize) {
    // Left edge - go back
    if (Date.now() - lastGazeTime > 1500) {
      window.history.back();
      lastGazeTime = Date.now() + 2000; // Prevent immediate re-trigger
    }
  } else if (gazePoint.x > window.innerWidth - edgeSize) {
    // Right edge - go forward
    if (Date.now() - lastGazeTime > 1500) {
      window.history.forward();
      lastGazeTime = Date.now() + 2000; // Prevent immediate re-trigger
    }
  }
}

// Handle auto scrolling when looking at bottom of screen
function handleAutoScroll(gazePoint) {
  // Calculate bottom scroll zone height
  const scrollZone = window.innerHeight * 0.2;
  
  // Start scrolling when looking at bottom of screen
  if (gazePoint.y > window.innerHeight - scrollZone) {
    if (!isScrolling) {
      isScrolling = true;
      startAutoScroll();
    }
  } else {
    isScrolling = false;
  }
}

// Start auto scrolling
function startAutoScroll() {
  if (!isScrolling) return;
  
  // Scroll speed based on settings (1-10)
  const scrollStep = settings.scrollSpeed * 2;
  
  // Perform scroll
  window.scrollBy(0, scrollStep);
  
  // Continue scrolling
  setTimeout(() => {
    if (isScrolling) {
      startAutoScroll();
    }
  }, 30);
}

// Cleanup resources
function cleanup() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    
    // Notifier le background script que la caméra est inactive
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: false
    });
  }
  
  if (cursor) {
    document.body.removeChild(cursor);
  }
  
  if (video) {
    document.body.removeChild(video);
  }
  
  if (canvas) {
    document.body.removeChild(canvas);
  }
}

// Fonction pour restaurer la caméra lors du changement d'onglet
async function restoreCamera() {
  if (isActive && !webcamStream) {
    console.log('GazeTech: Restauration de la caméra après changement d\'onglet');
    await initializeTracking();
  }
}

// Initialize the extension
async function initialize() {
  await loadSettings();
  
  // Only initialize if active
  if (isActive) {
    initializeUI();
    await initializeTracking();
  }
  
  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggleExtension') {
      isActive = request.isActive;
      
      if (cursor) {
        cursor.style.display = isActive ? 'block' : 'none';
      }
      
      sendResponse({ success: true });
    }
    
    if (request.action === 'settingsUpdated') {
      loadSettings().then(() => {
        sendResponse({ success: true });
      });
      return true; // Required for asynchronous sendResponse
    }

    // Nouveau gestionnaire pour démarrer le suivi des yeux après la calibration
    if (request.action === 'startEyeTracking') {
      // Mettre à jour les paramètres avec les nouvelles données de calibration
      if (request.calibrationData) {
        calibrationData = request.calibrationData;
        isCalibrated = true;
      }
      
      // Mettre à jour les paramètres si fournis
      if (request.settings) {
        settings = { ...settings, ...request.settings };
      }
      
      isActive = true;
      
      // S'assurer que l'interface est initialisée
      if (!cursor) {
        initializeUI();
      }
      
      // Démarrer ou continuer le suivi si la webcam est déjà active
      if (!webcamStream) {
        initializeTracking().then(() => {
          sendResponse({ success: true });
        }).catch(error => {
          console.error('Erreur lors du démarrage du suivi des yeux:', error);
          sendResponse({ success: false, error: error.message });
        });
      } else {
        sendResponse({ success: true });
      }
      
      return true; // Required for asynchronous sendResponse
    }
    
    // Nouveau gestionnaire pour restaurer la caméra après changement d'onglet
    if (request.action === 'restoreCamera' && request.shouldRestore) {
      restoreCamera().then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        console.error('GazeTech: Erreur lors de la restauration de la caméra:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true; // Required for asynchronous sendResponse
    }
  });
}

// Start the extension
initialize().catch(error => {
  console.error('GazeTech: Failed to initialize extension:', error);
});

// Clean up when page is unloaded
window.addEventListener('beforeunload', cleanup);

// Détecter quand la page devient visible/invisible pour gérer la caméra
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isActive) {
    // La page est à nouveau visible, restaurer la caméra si nécessaire
    restoreCamera();
  }
});

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
let restoreCameraAttempts = 0;
const MAX_RESTORE_ATTEMPTS = 3;

// Enhanced tracking parameters
let headTracking = {
  xOffset: 0,
  yOffset: 0,
  xScale: 1.5, // Increased movement amplification
  yScale: 1.5, // Increased movement amplification
  smoothFactor: 0.3 // Reduced smoothing for more immediate response
};

// Load settings from storage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      settings = items;
      isActive = settings.isActive;
      isCalibrated = settings.calibrated;
      calibrationData = settings.calibrationData;
      
      // Apply eye movement sensitivity from settings
      if (settings.gazeSensitivity) {
        eyeMovementSensitivity = settings.gazeSensitivity;
        // Update tracking scaling based on sensitivity
        headTracking.xScale = 1.0 + (eyeMovementSensitivity * 0.3); // More dynamic range
        headTracking.yScale = 1.0 + (eyeMovementSensitivity * 0.3);
        // Adjust smoothing to be more responsive at high sensitivity
        headTracking.smoothFactor = Math.max(0.1, 0.5 - (eyeMovementSensitivity * 0.04));
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
    transition: transform 0.1s ease-out, background-color 0.2s; 
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
  
  // Add calibration indicator for debugging
  const debugIndicator = document.createElement('div');
  debugIndicator.id = 'gazetech-debug';
  debugIndicator.style.cssText = `
    position: fixed;
    bottom: 10px;
    right: 10px;
    background-color: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 12px;
    z-index: 999999;
    display: none;
  `;
  document.body.appendChild(debugIndicator);
}

// Initialize webcam and face tracking
async function initializeTracking() {
  if (cameraInitialized) {
    console.log('Camera already initialized, skipping');
    return;
  }

  try {
    // Access webcam
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }
    });
    
    video.srcObject = webcamStream;
    await video.play();
    cameraInitialized = true;
    
    // Show debug info temporarily
    const debugIndicator = document.getElementById('gazetech-debug');
    if (debugIndicator) {
      debugIndicator.textContent = "Camera initialized";
      debugIndicator.style.display = "block";
      setTimeout(() => {
        debugIndicator.style.display = "none";
      }, 3000);
    }
    
    // Notify the background script that camera is active
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: true
    }).catch(error => {
      console.log("Failed to notify background script about camera status:", error);
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
    cameraInitialized = false;
    
    // Notify failure
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: false
    }).catch(() => {});
  }
}

// Main tracking function
async function trackFace() {
  if (!isActive || !faceMesh) {
    requestAnimationFrame(trackFace);
    return;
  }

  try {
    // Check if video is playing and ready
    if (!video.videoWidth || !video.videoHeight) {
      console.log('Video not ready yet, retrying...');
      requestAnimationFrame(trackFace);
      return;
    }

    // Process video frame
    const predictions = await faceMesh.estimateFaces({
      input: video,
      flipHorizontal: false
    });
    
    if (predictions.length > 0) {
      const face = predictions[0];
      
      // Process eye data with enhanced tracking
      const eyeData = processEyeData(face);
      
      // Debug - display position in debug element
      updateDebugInfo(eyeData.gazePoint.x, eyeData.gazePoint.y);
      
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
    } else {
      console.log('No face detected');
    }
  } catch (error) {
    console.error('GazeTech: Error tracking face:', error);
  }
  
  // Continue tracking loop
  requestAnimationFrame(trackFace);
}

// Update debug information
function updateDebugInfo(x, y) {
  const debugIndicator = document.getElementById('gazetech-debug');
  if (debugIndicator && Math.random() < 0.05) { // Only update occasionally to avoid performance issues
    debugIndicator.style.display = "block";
    debugIndicator.textContent = `Gaze: ${Math.round(x)},${Math.round(y)} | Sens: ${eyeMovementSensitivity}`;
    setTimeout(() => {
      debugIndicator.style.display = "none";
    }, 1000);
  }
}

// Process eye data to determine gaze point and blink state - COMPLETELY REVISED
function processEyeData(face) {
  // Get face landmarks
  const landmarks = face.scaledMesh;
  
  // Use more face landmarks for better tracking
  // Get specific points for better eye tracking
  const noseTop = landmarks[6];  // Top of nose bridge
  const noseTip = landmarks[1];  // Tip of nose
  const leftEye = landmarks[159]; // Left eye center
  const rightEye = landmarks[386]; // Right eye center
  const leftEyeTop = landmarks[159 - 20]; // Approximate
  const leftEyeBottom = landmarks[159 + 20]; // Approximate
  
  // Calculate head rotation and position
  const faceWidth = Math.abs(landmarks[454][0] - landmarks[234][0]); // Distance between ears
  const headX = (noseTip[0] - (video.width / 2)) / (video.width / 2);
  const headY = (noseTip[1] - (video.height / 2)) / (video.height / 2);
  
  // Calculate eye openness (for blink detection)
  const leftEyeHeight = Math.abs(leftEyeTop[1] - leftEyeBottom[1]) / faceWidth;
  const isBlinking = leftEyeHeight < 0.02; // Normalized threshold for blinking
  
  // Apply calibration if available
  let calibratedX = headX;
  let calibratedY = headY;
  
  if (calibrationData && calibrationData.length >= 5) {
    // Use calibration data to normalize the gaze point
    // Simple calibration correction (in real implementation, this would be more sophisticated)
    const centerCalibration = calibrationData[0];
    if (centerCalibration && centerCalibration.eyeData) {
      // Apply offsets based on calibration center point
      calibratedX = headX - (centerCalibration.eyeData.x / 200) + 0.1;
      calibratedY = headY - (centerCalibration.eyeData.y / 200) + 0.1;
    }
  }
  
  // Apply amplification based on sensitivity
  const amplifiedX = calibratedX * headTracking.xScale;
  const amplifiedY = calibratedY * headTracking.yScale;
  
  // Map to screen with enhanced non-linear response for finer center control
  // This creates an S-curve response that's more sensitive in the center
  const screenX = window.innerWidth * (0.5 + Math.pow(amplifiedX, eyeMovementSensitivity > 5 ? 1 : 3) * 0.8);
  const screenY = window.innerHeight * (0.5 + Math.pow(amplifiedY, eyeMovementSensitivity > 5 ? 1 : 3) * 0.8);
  
  // Apply smoothing with previous position (reduced for more responsiveness)
  const smoothedX = lastGazePoint.x * headTracking.smoothFactor + screenX * (1 - headTracking.smoothFactor);
  const smoothedY = lastGazePoint.y * headTracking.smoothFactor + screenY * (1 - headTracking.smoothFactor);
  
  const gazePoint = { 
    x: Math.max(0, Math.min(window.innerWidth, smoothedX)),
    y: Math.max(0, Math.min(window.innerHeight, smoothedY))
  };
  
  lastGazePoint = gazePoint;
  
  return {
    gazePoint,
    isBlinking
  };
}

// Update cursor position based on gaze point
function updateCursorPosition(gazePoint) {
  if (cursor) {
    // Apply slight animation for smoother movement
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
    
    // Notify the background script that camera is inactive
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: false
    }).catch(() => {});
    
    cameraInitialized = false;
  }
  
  if (cursor && document.body.contains(cursor)) {
    document.body.removeChild(cursor);
    cursor = null;
  }
  
  if (video && document.body.contains(video)) {
    document.body.removeChild(video);
    video = null;
  }
  
  if (canvas && document.body.contains(canvas)) {
    document.body.removeChild(canvas);
    canvas = null;
  }
  
  const debugIndicator = document.getElementById('gazetech-debug');
  if (debugIndicator && document.body.contains(debugIndicator)) {
    document.body.removeChild(debugIndicator);
  }
}

// Function to restore camera between tab switches
async function restoreCamera() {
  console.log('GazeTech: Attempting to restore camera');
  
  if (isActive && !cameraInitialized) {
    if (restoreCameraAttempts >= MAX_RESTORE_ATTEMPTS) {
      console.log('GazeTech: Maximum camera restore attempts reached');
      restoreCameraAttempts = 0;
      return;
    }
    
    restoreCameraAttempts++;
    console.log(`GazeTech: Camera restore attempt ${restoreCameraAttempts}/${MAX_RESTORE_ATTEMPTS}`);
    
    try {
      // Re-initialize UI elements if they were removed
      if (!cursor || !video || !canvas) {
        initializeUI();
      }
      
      await initializeTracking();
      restoreCameraAttempts = 0;
      console.log('GazeTech: Camera restored successfully');
    } catch (error) {
      console.error('GazeTech: Failed to restore camera:', error);
      
      // Try again with a delay
      setTimeout(restoreCamera, 1000);
    }
  } else if (cameraInitialized) {
    console.log('GazeTech: Camera already initialized, no need to restore');
    restoreCameraAttempts = 0;
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

    // Handler for starting eye tracking after calibration
    if (request.action === 'startEyeTracking') {
      // Update parameters with new calibration data
      if (request.calibrationData) {
        calibrationData = request.calibrationData;
        isCalibrated = true;
      }
      
      // Update settings if provided
      if (request.settings) {
        settings = { ...settings, ...request.settings };
      }
      
      isActive = true;
      
      // Ensure UI is initialized
      if (!cursor) {
        initializeUI();
      }
      
      // Start or continue tracking
      if (!cameraInitialized) {
        initializeTracking().then(() => {
          sendResponse({ success: true });
        }).catch(error => {
          console.error('Error starting eye tracking:', error);
          sendResponse({ success: false, error: error.message });
        });
      } else {
        sendResponse({ success: true });
      }
      
      return true; // Required for asynchronous sendResponse
    }
    
    // Handler for restoring camera after tab switch
    if (request.action === 'restoreCamera' && request.shouldRestore) {
      restoreCamera().then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        console.error('GazeTech: Error restoring camera:', error);
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

// Handle page visibility changes - improved to be more reliable
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isActive) {
    // Page is visible again, restore camera if needed
    console.log('GazeTech: Page visible, checking camera status');
    if (!cameraInitialized) {
      restoreCamera();
    }
  } else if (document.visibilityState === 'hidden') {
    console.log('GazeTech: Page hidden, camera will be preserved');
    // We don't close the camera here, so it can be restored when page is visible again
  }
});

// Handle focus/blur events as additional backup for visibility detection
window.addEventListener('focus', () => {
  console.log('GazeTech: Window focused');
  if (isActive && !cameraInitialized) {
    restoreCamera();
  }
});

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
let forceKeepCameraOn = false; // Flag to force keeping camera on even when tab loses focus

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
const MAX_RESTORE_ATTEMPTS = 10; // Increased maximum attempts for extreme persistence
let cameraRestorationInProgress = false;
let cameraRestorationQueue = []; // Queue for handling multiple restoration requests

// Camera activation persistence
let lastHeartbeatTime = 0;
const HEARTBEAT_INTERVAL = 500; // Every half-second for more reliability
let pendingForceActivation = false;
let lastRestorationAttemptTime = 0;
const MIN_RESTORATION_INTERVAL = 500; // Minimum time between restoration attempts

// Enhanced tracking parameters
let headTracking = {
  xOffset: 0,
  yOffset: 0,
  xScale: 2.5, // Increased movement amplification
  yScale: 2.5, // Increased movement amplification
  smoothFactor: 0.15 // Reduced smoothing for more immediate response
};

// Debug mode to show more visual feedback
let debugMode = true;

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
        // Update tracking scaling based on sensitivity - more responsive
        headTracking.xScale = 1.8 + (eyeMovementSensitivity * 0.5); // More dynamic range
        headTracking.yScale = 1.8 + (eyeMovementSensitivity * 0.5);
        // Adjust smoothing to be more responsive at high sensitivity
        headTracking.smoothFactor = Math.max(0.05, 0.25 - (eyeMovementSensitivity * 0.03));
      }
      
      resolve(settings);
    });
  });
}

// Start heartbeat to keep camera active between tabs - improved version
function startHeartbeat() {
  // Clear any existing interval
  if (window.heartbeatInterval) {
    clearInterval(window.heartbeatInterval);
  }
  
  // Set up regular heartbeat to keep camera alive - more frequent and with force check
  window.heartbeatInterval = setInterval(() => {
    if (!document.hidden || forceKeepCameraOn) {
      const now = Date.now();
      if (now - lastHeartbeatTime > HEARTBEAT_INTERVAL) {
        lastHeartbeatTime = now;
        
        // Send heartbeat to background script
        chrome.runtime.sendMessage({
          action: 'heartbeat',
          hasCameraActive: cameraInitialized,
          requestForceCheck: !cameraInitialized // Request force check if camera not initialized
        }).then(response => {
          if (response && response.shouldHaveCamera && !cameraInitialized) {
            console.log("Heartbeat: Camera should be active, restoring");
            // Pass force flag if background script says to
            restoreCamera(response.forceRestore || false);
          }
        }).catch(error => {
          console.log("Heartbeat error:", error);
        });
      }
    }
  }, HEARTBEAT_INTERVAL);
  
  // Add a secondary "keepalive" interval that's even more aggressive
  window.keepAliveInterval = setInterval(() => {
    if (cameraInitialized && webcamStream) {
      // Verify camera stream is actually active
      const activeTracks = webcamStream.getVideoTracks().filter(track => track.readyState === 'live');
      if (activeTracks.length === 0) {
        console.log("KeepAlive: Camera stream lost, attempting to restore");
        cameraInitialized = false;
        restoreCamera(true);
      }
    }
  }, 3000);
}

// Initialize UI elements with debug option
function initializeUI() {
  // Create cursor element - more visible now
  cursor = document.createElement('div');
  cursor.id = 'gazetech-cursor';
  cursor.style.cssText = `
    position: fixed;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background-color: rgba(44, 123, 229, 0.6);
    border: 3px solid rgba(44, 123, 229, 0.9);
    pointer-events: none;
    z-index: 999999;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 15px rgba(44, 123, 229, 0.7);
    display: ${isActive ? 'block' : 'none'};
    transition: transform 0.05s ease-out, background-color 0.2s; 
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
  video.autoplay = true;
  video.playsInline = true; // Important for iOS
  video.muted = true; // Required for autoplay in some browsers
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
  
  // Add debug indicator - always create it but show conditionally
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
  debugIndicator.textContent = "GazeTech initializing...";
  document.body.appendChild(debugIndicator);
  
  // Add status indicator to show camera state
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
  
  // Added persistent camera message
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
  
  // Show persistent message briefly
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
}

// Function to update the status indicator
function updateStatusIndicator(active) {
  const indicator = document.getElementById('gazetech-status');
  if (indicator) {
    indicator.style.backgroundColor = active ? 'lime' : 'red';
    indicator.style.boxShadow = active 
      ? '0 0 10px rgba(0, 255, 0, 0.7)' 
      : '0 0 5px rgba(255, 0, 0, 0.7)';
  }
}

// Show temporary notification
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
  
  // Remove notification after a few seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

// Initialize webcam and face tracking with improved error handling and restoration
async function initializeTracking() {
  if (cameraInitialized) {
    console.log('Camera already initialized, skipping');
    return;
  }
  
  if (cameraRestorationInProgress) {
    console.log('Camera restoration already in progress, queueing request');
    cameraRestorationQueue.push(Date.now());
    if (cameraRestorationQueue.length > 3) {
      // Too many requests in queue, force restart the process
      cameraRestorationInProgress = false;
    } else {
      return;
    }
  }
  
  // Debounce restoration attempts
  const now = Date.now();
  if (now - lastRestorationAttemptTime < MIN_RESTORATION_INTERVAL) {
    console.log('Restoration attempt too soon, delaying');
    setTimeout(() => {
      initializeTracking();
    }, MIN_RESTORATION_INTERVAL);
    return;
  }
  
  lastRestorationAttemptTime = now;
  cameraRestorationInProgress = true;
  cameraRestorationQueue = [];
  updateStatusIndicator(false);
  
  // Log attempt to initialize
  console.log('GazeTech: Attempting to initialize webcam');
  
  // Clear any existing webcam resources 
  if (webcamStream) {
    try {
      webcamStream.getTracks().forEach(track => {
        track.stop();
      });
      webcamStream = null;
    } catch (e) {
      console.log('Error stopping existing tracks:', e);
    }
  }

  try {
    // Access webcam with more specific constraints for better performance
    // And more persistence between tab switches
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        width: { ideal: 640, min: 320 },
        height: { ideal: 480, min: 240 }, 
        facingMode: "user",
        frameRate: { ideal: 30, min: 20 }  
      },
      audio: false
    });
    
    video.srcObject = webcamStream;
    
    // Add persistence flags to the stream tracks
    webcamStream.getTracks().forEach(track => {
      // These are unofficial flags but might help in some browsers
      track.contentHint = "persist";
      track.enabled = true; // Ensure track is enabled
    });
    
    // Ensure video auto-plays with better error recovery
    video.onloadedmetadata = async () => {
      try {
        await video.play();
      } catch (e) {
        console.error('GazeTech: Error playing video:', e);
        // Try again after a short delay
        setTimeout(() => {
          video.play().catch(e => console.log('Second play attempt failed:', e));
        }, 200);
      }
    };
    
    // Wait for video to be ready with timeout and multiple retry attempts
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Video play timeout'));
      }, 5000);
      
      let playAttempts = 0;
      
      const tryPlay = () => {
        playAttempts++;
        video.play()
          .then(resolve)
          .catch(e => {
            if (playAttempts < 3) {
              console.log(`Play attempt ${playAttempts} failed, retrying:`, e);
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
    
    // Show debug info
    const debugIndicator = document.getElementById('gazetech-debug');
    if (debugIndicator) {
      debugIndicator.textContent = "Camera initialized. Waiting for face detection...";
      setTimeout(() => {
        if (debugMode) {
          debugIndicator.style.opacity = "0.7";
        } else {
          debugIndicator.style.display = "none";
        }
      }, 3000);
    }
    
    // Update status indicator
    updateStatusIndicator(true);
    
    // Show notification
    showNotification("Caméra activée", "info");
    
    // Notify the background script that camera is active
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: true
    }).catch(error => {
      console.log("Failed to notify background script about camera status:", error);
    });
    
    // Add listeners to video element to track state
    video.onpause = () => {
      console.log('GazeTech: Video paused, attempting to restart');
      video.play().catch(e => console.error('Failed to restart video', e));
    };
    
    // Add event listener for tracks ending
    webcamStream.getTracks().forEach(track => {
      track.onended = () => {
        console.log('GazeTech: Camera track ended, attempting to restore');
        if (cameraInitialized) {
          cameraInitialized = false;
          restoreCamera(true);
        }
      };
    });
    
    // Load face mesh model if available
    if (window.facemesh) {
      try {
        faceMesh = await facemesh.load({
          maxFaces: 1,
          refineLandmarks: true,
          detectionConfidence: 0.8,
          predictIrises: true  // Better eye tracking by including iris prediction
        });
        
        // Start tracking loop
        requestAnimationFrame(trackFace);
        console.log('GazeTech: Face tracking initialized');
        
        if (debugIndicator) {
          debugIndicator.textContent = "Face tracking active";
          setTimeout(() => {
            if (!debugMode) {
              debugIndicator.style.display = "none";
            }
          }, 2000);
        }
      } catch (error) {
        console.error('GazeTech: Failed to load face mesh:', error);
        if (debugIndicator) {
          debugIndicator.textContent = "Failed to load face tracking";
          debugIndicator.style.backgroundColor = "rgba(255, 0, 0, 0.7)";
        }
      }
    } else {
      // Fallback model loading
      console.log('GazeTech: Waiting for facemesh to load...');
      if (debugIndicator) {
        debugIndicator.textContent = "Waiting for face tracking to load...";
      }
    }
    
    // Process any queued restoration requests
    if (cameraRestorationQueue.length > 0) {
      cameraRestorationQueue = []; // Clear queue
    }
  } catch (error) {
    console.error('GazeTech: Error initializing webcam:', error);
    cameraInitialized = false;
    cameraRestorationInProgress = false;
    
    // Update debug indicator
    const debugIndicator = document.getElementById('gazetech-debug');
    if (debugIndicator) {
      debugIndicator.textContent = "Camera error: " + error.message;
      debugIndicator.style.backgroundColor = "rgba(255, 0, 0, 0.7)";
      debugIndicator.style.display = "block";
    }
    
    // Update status indicator
    updateStatusIndicator(false);
    
    // Show notification
    showNotification("Erreur caméra: " + error.message, "error");
    
    // Notify failure
    chrome.runtime.sendMessage({
      action: 'cameraStatusUpdate',
      isActive: false
    }).catch(() => {});
    
    // Process any queued restoration requests
    if (cameraRestorationQueue.length > 0) {
      const oldestRequest = cameraRestorationQueue.shift();
      // If the request is recent, try again
      if (Date.now() - oldestRequest < 5000) {
        console.log('Retrying camera initialization from queue');
        setTimeout(() => {
          restoreCamera(true);
        }, 1000);
      }
    }
  }
}

// Main tracking function - completely revised for better responsiveness
async function trackFace() {
  if (!isActive || !faceMesh) {
    requestAnimationFrame(trackFace);
    return;
  }

  try {
    // Check if video is playing and ready
    if (!video.videoWidth || !video.videoHeight || video.paused) {
      if (debugMode) {
        console.log('Video not ready yet or paused, retrying...');
        updateStatusIndicator(false);
      }
      requestAnimationFrame(trackFace);
      return;
    }

    // Process video frame with higher confidence threshold
    const predictions = await faceMesh.estimateFaces({
      input: video,
      flipHorizontal: false,
      predictIrises: true
    });
    
    if (predictions.length > 0) {
      updateStatusIndicator(true);
      const face = predictions[0];
      
      // Process eye data with enhanced tracking
      const eyeData = processEyeData(face);
      
      // Debug - display position in debug element
      updateDebugInfo(eyeData.gazePoint.x, eyeData.gazePoint.y, eyeData.confidence);
      
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
      if (debugMode) {
        console.log('No face detected');
        const debugIndicator = document.getElementById('gazetech-debug');
        if (debugIndicator && Math.random() < 0.1) { 
          debugIndicator.textContent = "No face detected";
          debugIndicator.style.display = "block";
        }
        updateStatusIndicator(false);
      }
    }
  } catch (error) {
    console.error('GazeTech: Error tracking face:', error);
    updateStatusIndicator(false);
  }
  
  // Continue tracking loop
  requestAnimationFrame(trackFace);
}

// Update debug information with more details
function updateDebugInfo(x, y, confidence) {
  if (!debugMode) return;
  
  const debugIndicator = document.getElementById('gazetech-debug');
  if (debugIndicator && Math.random() < 0.05) { // Only update occasionally
    debugIndicator.style.display = "block";
    debugIndicator.textContent = `Gaze: ${Math.round(x)},${Math.round(y)} | Sens: ${eyeMovementSensitivity} | Conf: ${confidence.toFixed(2)}`;
  }
}

// Process eye data to determine gaze point and blink state - COMPLETELY REVISED
function processEyeData(face) {
  // Get face landmarks
  const landmarks = face.scaledMesh;
  
  // Use more specific landmarks for better eye tracking
  // These indices correspond to MediaPipe Face Mesh landmarks
  const rightEyeUpper = landmarks[159]; 
  const rightEyeLower = landmarks[145];
  const leftEyeUpper = landmarks[386];
  const leftEyeLower = landmarks[374];
  const rightEyeOuterCorner = landmarks[33];
  const rightEyeInnerCorner = landmarks[133];
  const leftEyeOuterCorner = landmarks[263];
  const leftEyeInnerCorner = landmarks[362];
  const noseTip = landmarks[1];
  const foreheadCenter = landmarks[10];
  
  // Calculate head pose more precisely
  const rightEyeCenter = {
    x: (rightEyeInnerCorner[0] + rightEyeOuterCorner[0]) / 2,
    y: (rightEyeUpper[1] + rightEyeLower[1]) / 2
  };
  
  const leftEyeCenter = {
    x: (leftEyeInnerCorner[0] + leftEyeOuterCorner[0]) / 2,
    y: (leftEyeUpper[1] + leftEyeLower[1]) / 2
  };
  
  // Calculate face size for normalization
  const faceWidth = Math.sqrt(
    Math.pow(landmarks[454][0] - landmarks[234][0], 2) +
    Math.pow(landmarks[454][1] - landmarks[234][1], 2)
  );
  
  // Calculate eye openness for blink detection (normalized by face width)
  const rightEyeHeight = Math.abs(rightEyeUpper[1] - rightEyeLower[1]) / faceWidth;
  const leftEyeHeight = Math.abs(leftEyeUpper[1] - leftEyeLower[1]) / faceWidth;
  const eyeOpenness = (rightEyeHeight + leftEyeHeight) / 2;
  
  // More precise blink detection with threshold adjusted by sensitivity
  const blinkThreshold = 0.018 - (0.001 * (eyeMovementSensitivity - 5));
  const isBlinking = eyeOpenness < blinkThreshold;
  
  // Calculate gaze vector using eye-to-nose relationships
  let headX = (((rightEyeCenter.x + leftEyeCenter.x) / 2) - (video.width / 2)) / (video.width / 3);
  let headY = (((rightEyeCenter.y + leftEyeCenter.y) / 2) - (video.height / 2)) / (video.height / 3);
  
  // Use eye direction relative to head
  const eyeDirectionX = (leftEyeCenter.x - rightEyeCenter.x) / faceWidth;
  const eyeDirectionY = ((leftEyeCenter.y + rightEyeCenter.y) / 2 - noseTip[1]) / faceWidth;
  
  // Combine head position and eye direction with weighted influence
  const gazeX = headX * 0.7 + eyeDirectionX * 5.0;
  const gazeY = headY * 0.7 + eyeDirectionY * 5.0;
  
  // Apply calibration if available
  let calibratedX = gazeX;
  let calibratedY = gazeY;
  
  if (calibrationData && calibrationData.length >= 5) {
    // Use calibration data to normalize the gaze point
    // Simple calibration correction (in real implementation, this would be more sophisticated)
    const centerCalibration = calibrationData[0];
    if (centerCalibration && centerCalibration.eyeData) {
      // Apply offsets based on calibration center point
      calibratedX = gazeX - (centerCalibration.eyeData.x / 100);
      calibratedY = gazeY - (centerCalibration.eyeData.y / 100);
    }
  }
  
  // Apply amplification based on sensitivity (non-linear scaling for better control)
  const sensitivityFactor = Math.pow(eyeMovementSensitivity / 5, 1.5);
  const amplifiedX = calibratedX * (headTracking.xScale * sensitivityFactor);
  const amplifiedY = calibratedY * (headTracking.yScale * sensitivityFactor);
  
  // Map to screen with enhanced non-linear response for finer control
  // Using cubic function for more precision in center area
  const screenX = window.innerWidth * (0.5 + Math.pow(amplifiedX, 3) * 0.5);
  const screenY = window.innerHeight * (0.5 + Math.pow(amplifiedY, 3) * 0.5);
  
  // Calculate confidence score (0-1) based on face visibility and stability
  const confidence = Math.min(1, faceWidth / (video.width * 0.4));
  
  // Apply adaptive smoothing based on confidence and movement speed
  // Lower smoothing (more responsive) when confidence is high and for larger movements
  const movementMagnitude = Math.sqrt(
    Math.pow(screenX - lastGazePoint.x, 2) + 
    Math.pow(screenY - lastGazePoint.y, 2)
  ) / Math.sqrt(Math.pow(window.innerWidth, 2) + Math.pow(window.innerHeight, 2));
  
  // Adaptively reduce smoothing for larger movements or when highly confident
  const adaptiveSmoothing = Math.max(
    0.05,  // minimum smoothing (maximum responsiveness)
    headTracking.smoothFactor * (1 - confidence * 0.5) * (1 - movementMagnitude * 2)
  );
  
  // Apply smoothing
  const smoothedX = lastGazePoint.x * adaptiveSmoothing + screenX * (1 - adaptiveSmoothing);
  const smoothedY = lastGazePoint.y * adaptiveSmoothing + screenY * (1 - adaptiveSmoothing);
  
  // Constrain to screen bounds with small margin
  const gazePoint = { 
    x: Math.max(10, Math.min(window.innerWidth - 10, smoothedX)),
    y: Math.max(10, Math.min(window.innerHeight - 10, smoothedY))
  };
  
  // Update last gaze point
  lastGazePoint = gazePoint;
  
  return {
    gazePoint,
    isBlinking,
    confidence
  };
}

// Update cursor position based on gaze point with smooth animation
function updateCursorPosition(gazePoint) {
  if (cursor) {
    // Apply slight animation for smoother movement
    cursor.style.transform = `translate(${gazePoint.x}px, ${gazePoint.y}px) translate(-50%, -50%)`;
    
    // Add subtle visual feedback for movement
    const movementMagnitude = Math.sqrt(
      Math.pow(gazePoint.x - parseFloat(cursor.dataset.lastX || gazePoint.x), 2) + 
      Math.pow(gazePoint.y - parseFloat(cursor.dataset.lastY || gazePoint.y), 2)
    );
    
    // Store last position
    cursor.dataset.lastX = gazePoint.x;
    cursor.dataset.lastY = gazePoint.y;
    
    // Visual feedback on significant movement
    if (movementMagnitude > 30) {
      cursor.style.transform += ' scale(1.2)';
      setTimeout(() => {
        cursor.style.transform = `translate(${gazePoint.x}px, ${gazePoint.y}px) translate(-50%, -50%)`;
      }, 150);
    }
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
    cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.6)';
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
    cursor.style.backgroundColor = 'rgba(44, 123, 229, 0.6)';
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

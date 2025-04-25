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
let eyeMovementSensitivity = 7; // Increased sensitivity (was 3) for more responsive eye movements
let restoreCameraAttempts = 0;
const MAX_RESTORE_ATTEMPTS = 20; // Increased maximum attempts for extreme persistence
let cameraRestorationInProgress = false;
let cameraRestorationQueue = []; // Queue for handling multiple restoration requests

// Camera activation persistence
let lastHeartbeatTime = 0;
const HEARTBEAT_INTERVAL = 300; // More frequent heartbeats for better reliability
let pendingForceActivation = false;
let lastRestorationAttemptTime = 0;
const MIN_RESTORATION_INTERVAL = 300; // Reduced minimum time between restoration attempts

// Enhanced tracking parameters
let headTracking = {
  xOffset: 0,
  yOffset: 0,
  xScale: 3.5, // Significantly increased movement amplification (was 2.5)
  yScale: 3.5, // Significantly increased movement amplification (was 2.5)
  smoothFactor: 0.10 // Further reduced smoothing for even more immediate response (was 0.15)
};

// Debug mode to show more visual feedback
let debugMode = true;

// Track if calibration has just completed
let justCalibrated = false;

// Flag to force extreme camera persistence
let forceCameraPersistence = true;

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
        headTracking.xScale = 2.5 + (eyeMovementSensitivity * 0.7); // More dynamic range for cursor movement
        headTracking.yScale = 2.5 + (eyeMovementSensitivity * 0.7);
        // Adjust smoothing to be more responsive at high sensitivity
        headTracking.smoothFactor = Math.max(0.03, 0.25 - (eyeMovementSensitivity * 0.03));
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
  
  // Set up regular heartbeat to keep camera alive - more frequent
  window.heartbeatInterval = setInterval(() => {
    if (!document.hidden || forceKeepCameraOn) {
      const now = Date.now();
      if (now - lastHeartbeatTime > HEARTBEAT_INTERVAL) {
        lastHeartbeatTime = now;
        
        // Send heartbeat to background script
        chrome.runtime.sendMessage({
          action: 'heartbeat',
          hasCameraActive: cameraInitialized,
          requestForceCheck: !cameraInitialized || forceCameraPersistence // Always request force check
        }).then(response => {
          if (response && response.shouldHaveCamera && !cameraInitialized) {
            console.log("Heartbeat: Camera should be active, restoring");
            // Pass force flag if background script says to
            restoreCamera(true);
          }
          
          // Update persistent flag from background
          if (response && response.forcePersistence) {
            forceCameraPersistence = true;
            forceKeepCameraOn = true;
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
    } else if (forceCameraPersistence) {
      // If camera should be active but isn't, restore it
      restoreCamera(true);
    }
  }, 1000);
  
  // Add a third emergency camera check - even more aggressive
  window.emergencyCameraInterval = setInterval(() => {
    if (forceCameraPersistence || justCalibrated) {
      // Force restore camera anyway, regardless of state
      restoreCamera(true);
      
      // Reset calibration flag after a while
      if (justCalibrated && Date.now() - lastRestorationAttemptTime > 10000) {
        justCalibrated = false;
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
    transition: transform 0.03s ease-out, background-color 0.2s; 
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
  video.setAttribute('playsinline', ''); // Additional for iOS
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

// Function to force restore camera with exponential backoff
function restoreCamera(force = false) {
  console.log("Attempting to restore camera, force:", force);
  
  if (cameraInitialized && !force) {
    console.log("Camera already initialized, no need to restore");
    return;
  }

  // Use exponential backoff to prevent too many rapid restoration attempts
  const now = Date.now();
  if (now - lastRestorationAttemptTime < MIN_RESTORATION_INTERVAL && !force) {
    console.log("Too soon to try restoration again");
    return;
  }
  
  lastRestorationAttemptTime = now;
  restoreCameraAttempts++;
  
  // Only allow a certain number of restoration attempts to prevent browser lockups
  if (restoreCameraAttempts > MAX_RESTORE_ATTEMPTS && !force) {
    console.log("Maximum restore attempts reached, giving up");
    return;
  }
  
  // Show notification that we're restoring camera
  showNotification("Restauration de la caméra...");
  
  // Force initialize tracking with the force flag
  initializeTracking(force);
  
  // Schedule additional restoration attempts
  if (force && !cameraInitialized) {
    // Try again after delays with exponential backoff
    [500, 1000, 2000, 4000].forEach(delay => {
      setTimeout(() => {
        if (!cameraInitialized) {
          initializeTracking(true);
        }
      }, delay);
    });
  }
}

// Initialize webcam and face tracking with improved error handling and restoration
async function initializeTracking(force = false) {
  if (cameraInitialized && !force) {
    console.log('Camera already initialized, skipping');
    return;
  }
  
  if (cameraRestorationInProgress && !force) {
    console.log('Camera restoration already in progress, queueing request');
    cameraRestorationQueue.push(Date.now());
    return;
  }
  
  // For extreme persistence
  if (force) {
    // Kill any existing restoration in progress
    cameraRestorationInProgress = false;
    
    // Clear existing webcam resources first
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
  }
  
  // Debounce restoration attempts
  const now = Date.now();
  if (now - lastRestorationAttemptTime < MIN_RESTORATION_INTERVAL && !force) {
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
  console.log('GazeTech: Attempting to initialize webcam with force =', force);
  
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
    // Access webcam with more specific constraints and persistence flags
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
            if (playAttempts < 5) { // Increased from 3
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
    
    // Reset restoration attempts counter on successful initialization
    restoreCameraAttempts = 0;
    
    // Show debug info
    const debugIndicator = document.getElementById('gazetech-debug');
    if (debugIndicator) {
      debugIndicator.textContent = "Camera initialized. Waiting for face detection...";
      debugIndicator.style.display = "block";
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
      isActive: true,
      requiresPersistence: forceKeepCameraOn || forceCameraPersistence || justCalibrated
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
          detectionConfidence: 0.9,  // Increased for better accuracy
          predictIrises: true  // Better eye tracking by including iris prediction
        });
        
        // Start tracking loop
        requestAnimationFrame(trackFace);
        console.log('GazeTech: Face tracking initialized');
        
        if (debugIndicator) {
          debugIndicator.textContent = "Face tracking active";
          debugIndicator.style.display = "block";
        }
      } catch (error) {
        console.error('GazeTech: Failed to load face mesh:', error);
        if (debugIndicator) {
          debugIndicator.textContent = "Failed to load face tracking";
          debugIndicator.style.backgroundColor = "rgba(255, 0, 0, 0.7)";
          debugIndicator.style.display = "block";
        }
      }
    } else {
      // Fallback model loading
      console.log('GazeTech: Waiting for facemesh to load...');
      if (debugIndicator) {
        debugIndicator.textContent = "Waiting for face tracking to load...";
        debugIndicator.style.display = "block";
      }
      
      // Try checking for facemesh periodically
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
            console.log('GazeTech: Face tracking initialized (delayed)');
            
            if (debugIndicator) {
              debugIndicator.textContent = "Face tracking active";
            }
          }).catch(error => {
            console.error('GazeTech: Failed to load face mesh (delayed):', error);
          });
        }
      }, 500);
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
    
    // Try again later if force persistence is enabled
    if (forceCameraPersistence || justCalibrated) {
      setTimeout(() => {
        restoreCamera(true);
      }, 2000);
    }
    
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
  const rightIris = landmarks[473]; // More precise iris point
  const leftIris = landmarks[468];  // More precise iris point
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
  const blinkThreshold = 0.015 - (0.001 * (eyeMovementSensitivity - 5));
  const isBlinking = eyeOpenness < blinkThreshold;
  
  // Calculate gaze vector using iris positions relative to eye corners for better accuracy
  const rightEyeWidth = Math.abs(rightEyeOuterCorner[0] - rightEyeInnerCorner[0]);
  const leftEyeWidth = Math.abs(leftEyeOuterCorner[0] - leftEyeInnerCorner[0]);
  
  // Calculate iris position within eye socket
  const rightIrisPosition = {
    x: (rightIris[0] - rightEyeInnerCorner[0]) / rightEyeWidth - 0.5,
    y: (rightIris[1] - ((rightEyeUpper[1] + rightEyeLower[1]) / 2)) / (rightEyeHeight * faceWidth)
  };
  
  const leftIrisPosition = {
    x: (leftIris[0] - leftEyeInnerCorner[0]) / leftEyeWidth - 0.5,
    y: (leftIris[1] - ((leftEyeUpper[1] + leftEyeLower[1]) / 2)) / (leftEyeHeight * faceWidth)
  };
  
  // Combine iris positions
  const combinedIrisX = (rightIrisPosition.x + leftIrisPosition.x) / 2;
  const combinedIrisY = (rightIrisPosition.y + leftIrisPosition.y) / 2;
  
  // Calculate head position
  let headX = (((rightEyeCenter.x + leftEyeCenter.x) / 2) - (video.width / 2)) / (video.width / 3);
  let headY = (((rightEyeCenter.y + leftEyeCenter.y) / 2) - (video.height / 2)) / (video.height / 3);
  
  // Enhanced algorithm that combines head position and iris position
  // Iris position is weighted more heavily for a more responsive cursor
  const gazeX = headX * 0.3 + combinedIrisX * 3.0;
  const gazeY = headY * 0.3 + combinedIrisY * 3.0;
  
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
  const sensitivityFactor = Math.pow(eyeMovementSensitivity / 5, 1.7); // Increased non-linearity (was 1.5)
  const amplifiedX = calibratedX * (headTracking.xScale * sensitivityFactor);
  const amplifiedY = calibratedY * (headTracking.yScale * sensitivityFactor);
  
  // Enhanced non-linear mapping for better precision
  // Using higher-order function (cubic -> quintic) for more precision
  const screenX = window.innerWidth * (0.5 + Math.pow(amplifiedX, 5) * 0.05);
  const screenY = window.innerHeight * (0.5 + Math.pow(amplifiedY, 5) * 0.05);
  
  // Calculate confidence score (0-1) based on face visibility and stability
  const confidence = Math.min(1, faceWidth / (video.width * 0.4));
  
  // Apply reduced smoothing for more responsive cursor
  // Lower smoothing (more responsive) when confidence is high and for larger movements
  const movementMagnitude = Math.sqrt(
    Math.pow(screenX - lastGazePoint.x, 2) + 
    Math.pow(screenY - lastGazePoint.y, 2)
  ) / Math.sqrt(Math.pow(window.innerWidth, 2) + Math.pow(window.innerHeight, 2));
  
  // Adaptively reduce smoothing for larger movements or when highly confident
  const adaptiveSmoothing = Math.max(
    0.02,  // minimum smoothing (maximum responsiveness) - reduced from 0.05
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
    // Apply direct positioning for immediate response
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
      cursor.style.transform += ' scale(1.3)';
      setTimeout(() => {
        cursor.style.transform = `translate(${gazePoint.x}px, ${gazePoint.y}px) translate(-50%, -50%)`;
      }, 100); // Faster reset (was 150ms)
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
          
          // Apply zoom effect
          element.style.transition = 'transform 0.3s ease-out';
          element.style.transform = 'scale(1.5)';
          element.style.zIndex = '9999';
          
          // Reset zoom after looking away
          setTimeout(() => {
            if (element.hasAttribute('data-gazetech-zoomed')) {
              const lookingAway = document.elementFromPoint(gazePoint.x, gazePoint.y) !== element;
              if (lookingAway) {
                resetZoom(element);
              } else {
                // Check again later
                const checkInterval = setInterval(() => {
                  const currentElement = document.elementFromPoint(lastGazePoint.x, lastGazePoint.y);
                  if (currentElement !== element) {
                    resetZoom(element);
                    clearInterval(checkInterval);
                  }
                }, 500);
                
                // Safety timeout to ensure we don't leave elements zoomed forever
                setTimeout(() => {
                  clearInterval(checkInterval);
                  resetZoom(element);
                }, 10000);
              }
            }
          }, 3000);
        }
        // Handle text elements
        else if (element.tagName === 'P' || element.tagName === 'DIV' || element.tagName === 'SPAN' || 
                element.tagName === 'H1' || element.tagName === 'H2' || element.tagName === 'H3' || 
                element.tagName === 'LI' || element.tagName === 'A') {
          
          element.setAttribute('data-gazetech-zoomed', 'true');
          
          // Store original styles
          const originalStyle = {
            fontSize: element.style.fontSize,
            transition: element.style.transition,
            backgroundColor: element.style.backgroundColor
          };
          
          element.setAttribute('data-original-style', JSON.stringify(originalStyle));
          
          // Get computed font size and increase it
          const computedStyle = window.getComputedStyle(element);
          const currentSize = parseFloat(computedStyle.fontSize);
          
          // Apply zoom effect
          element.style.transition = 'font-size 0.3s ease-out, background-color 0.3s ease-out';
          element.style.fontSize = `${currentSize * 1.3}px`;
          element.style.backgroundColor = 'rgba(44, 123, 229, 0.05)';
          
          // Reset zoom after looking away
          setTimeout(() => {
            if (element.hasAttribute('data-gazetech-zoomed')) {
              const lookingAway = document.elementFromPoint(gazePoint.x, gazePoint.y) !== element;
              if (lookingAway) {
                resetZoom(element);
              } else {
                // Check again later
                const checkInterval = setInterval(() => {
                  const currentElement = document.elementFromPoint(lastGazePoint.x, lastGazePoint.y);
                  if (currentElement !== element) {
                    resetZoom(element);
                    clearInterval(checkInterval);
                  }
                }, 500);
                
                // Safety timeout
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
    
    // Update last zoom element
    lastZoomElement = element;
  } else {
    // Reset last zoom element if not looking at anything
    lastZoomElement = null;
  }
  
  // Update last gaze time
  lastGazeTime = now;
}

// Reset zoom effect on an element
function resetZoom(element) {
  if (element && element.hasAttribute('data-gazetech-zoomed')) {
    element.removeAttribute('data-gazetech-zoomed');
    
    // Restore original styles
    if (element.hasAttribute('data-original-style')) {
      try {
        const originalStyle = JSON.parse(element.getAttribute('data-original-style'));
        
        // Apply original styles
        for (const [key, value] of Object.entries(originalStyle)) {
          element.style[key] = value;
        }
      } catch (e) {
        console.error('Error restoring original style:', e);
      }
      
      element.removeAttribute('data-original-style');
    }
  }
}

// Handle text-to-speech for elements being looked at
function handleTextToSpeech(gazePoint) {
  if (isSpeaking) return; // Don't start new speech if already speaking
  
  const now = Date.now();
  const element = document.elementFromPoint(gazePoint.x, gazePoint.y);
  
  if (element) {
    // If looking at the same text element for a while
    if (element === lastTextElement && now - lastGazeTime > 2000) {
      // Get text content
      let textContent = '';
      
      if (element.tagName === 'IMG' && element.alt) {
        textContent = element.alt; // Use alt text for images
      } else if (element.tagName === 'INPUT' && element.value) {
        textContent = element.value; // Use value for input fields
      } else if (element.tagName === 'A') {
        textContent = element.textContent || element.innerText || 'Link'; // Use text or "Link" for links
      } else {
        textContent = element.textContent || element.innerText || ''; // Use text content for other elements
      }
      
      // Trim and limit length
      textContent = textContent.trim();
      if (textContent.length > 200) {
        textContent = textContent.substring(0, 197) + '...';
      }
      
      // Speak text if not empty
      if (textContent && textContent.length > 1) {
        speakText(textContent);
        
        // Highlight the element
        if (!element.classList.contains('gazetech-highlighted-text')) {
          element.classList.add('gazetech-highlighted-text');
          
          // Remove highlight after speech ends
          setTimeout(() => {
            element.classList.remove('gazetech-highlighted-text');
          }, textContent.length * 80); // Rough estimate of speech duration
        }
      }
    }
    
    // Update last text element
    lastTextElement = element;
  } else {
    // Reset last text element if not looking at anything
    lastTextElement = null;
  }
}

// Speak text using speech synthesis
function speakText(text) {
  if (!text || isSpeaking) return;
  
  // Cancel any ongoing speech
  speechSynthesis.cancel();
  
  // Create utterance
  const utterance = new SpeechSynthesisUtterance(text);
  
  // Set language based on page or default to English
  const pageLang = document.documentElement.lang || 'en';
  utterance.lang = pageLang;
  
  // Set rate from settings
  utterance.rate = settings.speechRate || 1;
  
  // Set event handlers
  utterance.onstart = () => {
    isSpeaking = true;
  };
  
  utterance.onend = () => {
    isSpeaking = false;
  };
  
  utterance.onerror = () => {
    isSpeaking = false;
  };
  
  // Speak
  speechSynthesis.speak(utterance);
}

// Handle navigation by looking at screen edges
function handleEdgeNavigation(gazePoint) {
  const edgeSize = settings.edgeSize || 10; // Default edge size is 10% of screen
  const edgeSizePixels = {
    x: window.innerWidth * (edgeSize / 100),
    y: window.innerHeight * (edgeSize / 100)
  };
  
  // Check if looking at left edge
  if (gazePoint.x < edgeSizePixels.x) {
    showEdgeIndicator('left');
    
    // If looking at edge for more than 1 second, navigate back
    if (Date.now() - lastGazeTime > 1000) {
      window.history.back();
      lastGazeTime = Date.now(); // Reset to prevent multiple navigations
    }
  }
  // Check if looking at right edge
  else if (gazePoint.x > window.innerWidth - edgeSizePixels.x) {
    showEdgeIndicator('right');
    
    // If looking at edge for more than 1 second, navigate forward
    if (Date.now() - lastGazeTime > 1000) {
      window.history.forward();
      lastGazeTime = Date.now(); // Reset to prevent multiple navigations
    }
  }
  // Check if looking at bottom edge for scrolling
  else if (gazePoint.y > window.innerHeight - edgeSizePixels.y) {
    showEdgeIndicator('bottom');
  }
  else {
    hideEdgeIndicators();
  }
}

// Show edge indicator
function showEdgeIndicator(edge) {
  // Create or get edge indicators
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
  
  // Activate the appropriate edge
  leftEdge.classList.toggle('gazetech-edge-active', edge === 'left');
  rightEdge.classList.toggle('gazetech-edge-active', edge === 'right');
  bottomEdge.classList.toggle('gazetech-edge-active', edge === 'bottom');
}

// Hide all edge indicators
function hideEdgeIndicators() {
  const edges = document.querySelectorAll('.gazetech-edge-left, .gazetech-edge-right, .gazetech-edge-bottom');
  edges.forEach(edge => {
    edge.classList.remove('gazetech-edge-active');
  });
}

// Handle auto scrolling based on gaze position
function handleAutoScroll(gazePoint) {
  if (!settings.autoScroll) return;
  
  const edgeSize = settings.edgeSize || 10; // Default edge size is 10% of screen
  const edgeSizePixels = {
    y: window.innerHeight * (edgeSize / 100)
  };
  
  // Check if looking at bottom edge
  if (gazePoint.y > window.innerHeight - edgeSizePixels.y) {
    // Start scrolling down if not already scrolling
    if (!isScrolling) {
      isScrolling = true;
      smoothScroll('down');
    }
  }
  // Check if looking at top edge
  else if (gazePoint.y < edgeSizePixels.y) {
    // Start scrolling up if not already scrolling
    if (!isScrolling) {
      isScrolling = true;
      smoothScroll('up');
    }
  }
  else {
    // Stop scrolling
    isScrolling = false;
  }
}

// Smooth scrolling function
function smoothScroll(direction) {
  if (!isScrolling) return;
  
  const scrollSpeed = settings.scrollSpeed || 5;
  const scrollAmount = direction === 'down' ? scrollSpeed : -scrollSpeed;
  
  // Scroll the page
  window.scrollBy({
    top: scrollAmount,
    behavior: 'auto' // Use 'auto' for smoother continuous scrolling
  });
  
  // Continue scrolling if still looking at edge
  requestAnimationFrame(() => {
    if (isScrolling) {
      smoothScroll(direction);
    }
  });
}

// Initialize when document is loaded
document.addEventListener('DOMContentLoaded', async function() {
  try {
    console.log("GazeTech: Content script loaded");
    
    // Load settings first
    await loadSettings();
    
    // Initialize UI
    initializeUI();
    
    // Start heartbeat immediately
    startHeartbeat();
    
    // Check if we should restore camera
    chrome.runtime.sendMessage({
      action: 'checkCameraStatus',
      forceCheck: true
    }).then(response => {
      console.log("Initial camera check:", response);
      if (response && (response.shouldActivate || response.forceRestore)) {
        // Initialize tracking immediately
        initializeTracking(true);
      }
    }).catch(error => {
      console.log("Initial camera check error:", error);
    });
    
    // Add message listeners
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'startEyeTracking') {
        console.log("Starting eye tracking with calibration data:", request.calibrationData);
        
        // Store calibration data
        calibrationData = request.calibrationData;
        justCalibrated = true;
        forceCameraPersistence = true;
        
        // Update settings if provided
        if (request.settings) {
          settings = { ...settings, ...request.settings };
          
          // Apply eye movement sensitivity
          if (settings.gazeSensitivity) {
            eyeMovementSensitivity = settings.gazeSensitivity;
            headTracking.xScale = 2.5 + (eyeMovementSensitivity * 0.7);
            headTracking.yScale = 2.5 + (eyeMovementSensitivity * 0.7);
            headTracking.smoothFactor = Math.max(0.03, 0.25 - (eyeMovementSensitivity * 0.03));
          }
        }
        
        // Force initialize camera if not already done
        if (!cameraInitialized) {
          initializeTracking(true);
        }
        
        // Update status
        isActive = true;
        isCalibrated = true;
        
        // Set calibration completion flag
        justCalibrated = true;
        
        // Store calibration to storage
        chrome.storage.sync.set({
          calibrated: true,
          calibrationData: calibrationData
        });
        
        // Notify background script that calibration is complete
        chrome.runtime.sendMessage({
          action: 'calibrationCompleted',
          calibrationData: calibrationData
        }).catch(() => {});
        
        // Show notification
        showNotification("Calibration terminée, suivi des yeux actif");
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'tabFocus') {
        console.log('Tab received focus notification:', request);
        tabInFocus = true;
        
        // Restore camera if needed
        if (request.shouldRestoreCamera || request.forceActivate) {
          restoreCamera(request.forceActivate || false);
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'tabBlur') {
        console.log('Tab is blurring but keeping camera alive');
        tabInFocus = false;
        
        // Keep camera on despite tab blur if required
        if (request.keepCameraAlive || forceCameraPersistence) {
          forceKeepCameraOn = true;
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'forceActivateCamera') {
        console.log('Force activate camera requested');
        forceKeepCameraOn = true;
        forceCameraPersistence = true;
        restoreCamera(true);
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'syncCameraState') {
        if (request.shouldBeActive && !cameraInitialized) {
          console.log('Sync: Camera should be active but isn\'t, restoring');
          forceKeepCameraOn = true;
          restoreCamera(true);
        }
        
        // Update persistence flag
        if (request.forcePersistence) {
          forceCameraPersistence = true;
          forceKeepCameraOn = true;
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      if (request.action === 'maintainCamera') {
        console.log('Maintain camera request received');
        
        // Update persistence flags
        if (request.forcePersistence) {
          forceCameraPersistence = true;
          forceKeepCameraOn = true;
        }
        
        // Force restore camera if we just completed calibration
        if (request.afterCalibration) {
          justCalibrated = true;
        }
        
        // Restore camera if not active
        if (!cameraInitialized) {
          restoreCamera(true);
        }
        
        sendResponse({ success: true });
        return true;
      }
      
      sendResponse({ success: false });
      return true;
    });
    
    // Add listeners for visibility changes
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Page is hidden (user switched tabs)
        console.log('Page hidden, maintaining camera if persistence is enabled');
        tabInFocus = false;
      } else {
        // Page is visible
        console.log('Page visible, restoring camera if needed');
        tabInFocus = true;
        
        // Restore camera if needed
        if (!cameraInitialized && (forceKeepCameraOn || forceCameraPersistence)) {
          restoreCamera(true);
        }
      }
    });
    
    // Add listeners for window focus/blur
    window.addEventListener('focus', () => {
      console.log('Window gained focus');
      tabInFocus = true;
      
      // Notify background script
      chrome.runtime.sendMessage({
        action: 'tabFocused',
      }).catch(() => {});
      
      // Restore camera if needed
      if (!cameraInitialized && (forceKeepCameraOn || forceCameraPersistence)) {
        restoreCamera(true);
      }
    });
    
    window.addEventListener('blur', () => {
      console.log('Window lost focus');
      tabInFocus = false;
      
      // Notify background script
      chrome.runtime.sendMessage({
        action: 'tabBlurred',
      }).catch(() => {});
    });
    
  } catch (error) {
    console.error("GazeTech: Error initializing content script:", error);
  }
});

// Extra safeguard: check camera state repeatedly
setInterval(() => {
  if (isActive && !cameraInitialized && (forceCameraPersistence || justCalibrated)) {
    console.log("Periodic camera check: camera should be active but isn't");
    restoreCamera(true);
  }
}, 5000);

// Initialize if document is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  console.log("Document already loaded, initializing");
  setTimeout(() => {
    loadSettings().then(() => {
      initializeUI();
      startHeartbeat();
      
      // Check if we should initialize camera
      chrome.runtime.sendMessage({
        action: 'checkCameraStatus',
        forceCheck: true
      }).then(response => {
        if (response && (response.shouldActivate || response.forceRestore)) {
          initializeTracking(true);
        }
      }).catch(error => {
        console.log("Initial camera check error:", error);
      });
    });
  }, 100);
}

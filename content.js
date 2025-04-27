import { GazeTechController } from './modules/GazeTechController';

let gazeTech: GazeTechController | null = null;
let settings = {};
let isInitialized = false;
let forceKeepCameraActive = true; // Always keep camera active unless explicitly stopped

// Load settings from storage
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      settings = items;
      resolve(settings);
    });
  });
}

// Initialize GazeTech
async function initialize() {
  if (isInitialized && gazeTech) {
    console.log('GazeTech already initialized, restoring camera');
    gazeTech.restoreCamera(true);
    gazeTech.setActive(true);
    return;
  }
  
  try {
    isInitialized = true;
    
    // Load settings first
    await loadSettings();

    // Create and initialize GazeTech controller
    gazeTech = new GazeTechController({
      debugMode: true,
      sensitivity: settings.gazeSensitivity || 9,
      smoothingFactor: 0.05,
      calibrationData: settings.calibrationData
    });

    await gazeTech.initialize();

    // Add message listeners
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      handleChromeMessage(request, sender, sendResponse);
      return true;
    });

    // Add visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Add window focus listeners
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    
    // Activate by default if calibration data exists
    if (settings.calibrationData && settings.calibrated) {
      console.log('Calibration data found, activating eye tracking automatically');
      gazeTech.setActive(true);
    }
    
    // Start heartbeat to maintain connection with background script
    startHeartbeat();

  } catch (error) {
    console.error('GazeTech initialization error:', error);
    isInitialized = false;
  }
}

// Heartbeat function with improved frequency for better persistence
function startHeartbeat() {
  setInterval(() => {
    if (gazeTech && forceKeepCameraActive) {
      chrome.runtime.sendMessage({
        action: 'heartbeat',
        hasCameraActive: true,
        tabUrl: window.location.href
      }).catch(() => {});
    }
  }, 500); // More frequent (every 500ms)
}

// Message handler
function handleChromeMessage(request: any, sender: any, sendResponse: Function) {
  console.log('Message received in content.js:', request.action);
  
  switch (request.action) {
    case 'startEyeTracking':
      if (gazeTech) {
        // Ensure eye tracking is active and activate with the received calibration data
        gazeTech.restoreCamera(true);
        
        // Update settings if provided
        if (request.calibrationData) {
          gazeTech.updateCalibrationData(request.calibrationData);
        }
        
        // Force camera to stay active after popup closes
        if (request.keepCameraActive) {
          forceKeepCameraActive = true;
          console.log('Camera set to stay active after popup closes');
        }
        
        // Force camera on if requested
        if (request.forceCamera) {
          gazeTech.restoreCamera(true);
        }
        
        // Ensure tracking is active
        gazeTech.setActive(true);
        
        console.log('Eye tracking activated with calibration data');
      }
      sendResponse({ success: true });
      break;
      
    case 'stopCamera':
      // New handler to stop the camera explicitly
      if (gazeTech) {
        gazeTech.setActive(false);
        gazeTech.cleanup();
        forceKeepCameraActive = false;
        console.log('Camera stopped by user request');
      }
      sendResponse({ success: true });
      break;
      
    case 'tabFocus':
    case 'forceActivateCamera':
    case 'syncCameraState':
    case 'maintainCamera':
      if (forceKeepCameraActive && gazeTech) {
        gazeTech.restoreCamera(true);
        gazeTech.setActive(true);
      } else if (!isInitialized && forceKeepCameraActive) {
        // Re-initialize if needed
        initialize();
      }
      sendResponse({ success: true });
      break;
      
    case 'tabBlur':
      // IMPORTANT: DON'T disable tracking on blur so it continues working when popup closes
      if (gazeTech && forceKeepCameraActive) {
        // Continue tracking even when popup is closed
        gazeTech.setActive(true);
      }
      sendResponse({ success: true });
      break;
      
    case 'toggleExtension':
      if (gazeTech) {
        // For toggle, we respect the requested state but ensure it's always active if not specified
        gazeTech.setActive(request.isActive !== false);
      }
      sendResponse({ success: true });
      break;
      
    case 'settingsUpdated':
      // Update gazeTech settings if provided
      if (request.settings && gazeTech) {
        if (request.settings.gazeSensitivity !== undefined) {
          // Re-create eye tracker with new sensitivity
          gazeTech = new GazeTechController({
            debugMode: true,
            sensitivity: request.settings.gazeSensitivity,
            smoothingFactor: 0.05,
            calibrationData: settings.calibrationData
          });
          
          // Re-initialize if active
          if (request.settings.isActive !== false && request.settings.cameraActive !== false) {
            gazeTech.initialize().then(() => {
              gazeTech.setActive(true);
            });
          }
        }
        
        // Update force keep camera flag
        forceKeepCameraActive = request.settings.cameraActive !== false;
      }
      sendResponse({ success: true });
      break;
      
    default:
      sendResponse({ success: false });
  }
}

// Visibility change handler with improved activation
function handleVisibilityChange() {
  if (!document.hidden && gazeTech && forceKeepCameraActive) {
    console.log("Document became visible, activating eye tracking");
    gazeTech.restoreCamera(true);
    gazeTech.setActive(true);
  }
}

// Window focus handlers with improved activation
function handleWindowFocus() {
  console.log("Window focus gained, activating eye tracking");
  if (gazeTech && forceKeepCameraActive) {
    gazeTech.restoreCamera(true);
    gazeTech.setActive(true);
  } else if (!isInitialized && forceKeepCameraActive) {
    // Re-initialize if needed
    initialize();
  }
  chrome.runtime.sendMessage({ action: 'tabFocused' }).catch(() => {});
}

function handleWindowBlur() {
  chrome.runtime.sendMessage({ action: 'tabBlurred' }).catch(() => {});
  // Important: DO NOT disable on blur so tracking continues working when popup closes
}

// Initialize if document is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(initialize, 100);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initialize, 100);
  });
}

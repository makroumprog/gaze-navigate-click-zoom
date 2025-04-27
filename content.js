import { GazeTechController } from './modules/GazeTechController';

let gazeTech: GazeTechController | null = null;
let settings = {};
let isInitialized = false;

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

// New heartbeat function to maintain connection with background script
function startHeartbeat() {
  setInterval(() => {
    if (gazeTech) {
      chrome.runtime.sendMessage({
        action: 'heartbeat',
        hasCameraActive: true,
        tabUrl: window.location.href
      }).catch(() => {});
    }
  }, 2000);
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
        
        // Ensure tracking is active
        gazeTech.setActive(true);
        
        console.log('Eye tracking activated with calibration data');
      }
      sendResponse({ success: true });
      break;
      
    case 'tabFocus':
    case 'forceActivateCamera':
    case 'syncCameraState':
    case 'maintainCamera':
      if (gazeTech) {
        gazeTech.restoreCamera(true);
        gazeTech.setActive(true);
      } else if (!isInitialized) {
        // Re-initialize if needed
        initialize();
      }
      sendResponse({ success: true });
      break;
      
    case 'tabBlur':
      // Important: Don't deactivate tracking on blur to keep it running when popup closes
      if (gazeTech) {
        gazeTech.setActive(true);
      }
      sendResponse({ success: true });
      break;
      
    case 'toggleExtension':
      if (gazeTech) {
        gazeTech.setActive(request.isActive !== false);
      }
      sendResponse({ success: true });
      break;
      
    default:
      sendResponse({ success: false });
  }
}

// Visibility change handler
function handleVisibilityChange() {
  if (!document.hidden && gazeTech) {
    gazeTech.restoreCamera(true);
    gazeTech.setActive(true);
  }
}

// Window focus handlers
function handleWindowFocus() {
  if (gazeTech) {
    gazeTech.restoreCamera(true);
    gazeTech.setActive(true);
  } else if (!isInitialized) {
    // Re-initialize if needed
    initialize();
  }
  chrome.runtime.sendMessage({ action: 'tabFocused' }).catch(() => {});
}

function handleWindowBlur() {
  chrome.runtime.sendMessage({ action: 'tabBlurred' }).catch(() => {});
  // Important: Don't deactivate on blur to keep tracking working when popup closes
}

// Initialize if document is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(initialize, 100);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initialize, 100);
  });
}

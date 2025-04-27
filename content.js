import { GazeTechController } from './modules/GazeTechController';

let gazeTech: GazeTechController | null = null;
let settings = {};

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
  try {
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

  } catch (error) {
    console.error('GazeTech initialization error:', error);
  }
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
      }
      sendResponse({ success: true });
      break;
      
    case 'tabBlur':
      if (gazeTech) {
        // Don't deactivate on blur to keep tracking when popup closes
        gazeTech.setActive(true);
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
  }
  chrome.runtime.sendMessage({ action: 'tabFocused' }).catch(() => {});
}

function handleWindowBlur() {
  chrome.runtime.sendMessage({ action: 'tabBlurred' }).catch(() => {});
}

// Initialize if document is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(initialize, 100);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initialize, 100);
  });
}

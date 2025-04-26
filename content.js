
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
  switch (request.action) {
    case 'startEyeTracking':
      if (gazeTech) {
        gazeTech.restoreCamera(true);
      }
      sendResponse({ success: true });
      break;
      
    case 'tabFocus':
    case 'tabBlur':
    case 'forceActivateCamera':
    case 'syncCameraState':
    case 'maintainCamera':
      if (gazeTech) {
        gazeTech.restoreCamera(true);
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
  }
}

// Window focus handlers
function handleWindowFocus() {
  if (gazeTech) {
    gazeTech.restoreCamera(true);
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

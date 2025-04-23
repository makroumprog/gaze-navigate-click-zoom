// Extension background script
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Initialize default settings
    chrome.storage.sync.set({
      isActive: true,
      gazeCursor: true,
      blinkClick: true,
      autoZoom: true,
      textSpeech: true,
      edgeNavigation: true,
      autoScroll: true,
      gazeSensitivity: 7, // Increased from 5 for better responsiveness
      blinkDelay: 500,
      zoomDelay: 2,
      speechRate: 1,
      edgeSize: 10,
      scrollSpeed: 5,
      calibrated: false
    }, () => {
      console.log('Extension installed. Default settings initialized.');
      
      // Open calibration page
      chrome.tabs.create({
        url: 'welcome.html'
      });
    });
  } else if (details.reason === 'update') {
    console.log('Extension updated to version ' + chrome.runtime.getManifest().version);
  }
});

// Global state to track camera status across tabs
let cameraActive = false;
let activeTabId = null;
// Keep track of all tabs with camera activated
let activeCameraTabs = new Set();
// Track when camera was last activated to prevent rapid toggling
let lastCameraActivationTime = 0;

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.sync.get(null, (settings) => {
      sendResponse(settings);
    });
    return true; // Required for asynchronous sendResponse
  }

  // Camera status update handler - enhanced with debouncing
  if (request.action === 'cameraStatusUpdate') {
    const now = Date.now();
    // Prevent rapid camera status changes (debounce)
    if (now - lastCameraActivationTime < 1000) {
      console.log("Camera status change ignored due to debouncing");
      sendResponse({ success: true, debounced: true });
      return true;
    }
    
    cameraActive = request.isActive;
    lastCameraActivationTime = now;
    
    if (sender.tab) {
      activeTabId = sender.tab.id;
      if (request.isActive) {
        activeCameraTabs.add(sender.tab.id);
        console.log("Camera activated in tab:", sender.tab.id);
        console.log("Active camera tabs:", Array.from(activeCameraTabs));
      } else {
        activeCameraTabs.delete(sender.tab.id);
        console.log("Camera deactivated in tab:", sender.tab.id);
        console.log("Active camera tabs:", Array.from(activeCameraTabs));
      }
    }
    sendResponse({ success: true });
    return true;
  }
  
  // New handler for tabs requesting camera status
  if (request.action === 'checkCameraStatus') {
    const tabHasCamera = sender.tab && activeCameraTabs.has(sender.tab.id);
    const shouldActivate = cameraActive && !tabHasCamera;
    
    sendResponse({ 
      cameraActive: cameraActive,
      shouldActivate: shouldActivate
    });
    return true;
  }
});

// Track tab changes - enhanced for better persistence
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Check if camera is active somewhere
  if (cameraActive && activeTabId !== activeInfo.tabId) {
    console.log(`Tab change detected: ${activeTabId} -> ${activeInfo.tabId}`);
    console.log("Active camera tabs:", Array.from(activeCameraTabs));
    
    // Improved camera restoration logic
    try {
      chrome.tabs.sendMessage(activeInfo.tabId, {
        action: 'restoreCamera',
        shouldRestore: true,
        fromTabId: activeTabId
      }).catch(error => {
        // This error often occurs if tab doesn't have content script yet
        console.log("Cannot restore camera on new tab:", error);
      });
      activeTabId = activeInfo.tabId;
    } catch (e) {
      console.error("Error sending restore camera message:", e);
    }
  }
});

// Handle tab closing
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCameraTabs.has(tabId)) {
    activeCameraTabs.delete(tabId);
    console.log("Tab closed, removed from active tabs:", tabId);
    console.log("Active camera tabs:", Array.from(activeCameraTabs));
    
    // If this was the last tab with camera, update global state
    if (activeCameraTabs.size === 0) {
      cameraActive = false;
    }
  }
});

// Track visibility changes - enhanced with proper error handling
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    // If tab has been fully loaded
    if (activeCameraTabs.has(tabId) || (cameraActive && tabId === activeTabId)) {
      console.log(`Tab ${tabId} updated to complete state, attempting to restore camera`);
      
      // Try to restore camera with a delay to allow content script to load
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, {
          action: 'restoreCamera',
          shouldRestore: true
        }).catch(() => {
          console.log(`Tab ${tabId} updated but couldn't restore camera`);
        });
      }, 500); // Short delay to allow content script to initialize
    }
  }
});

// Inject content scripts when the extension is activated
chrome.action.onClicked.addListener((tab) => {
  if (!tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } else {
    console.log('Cannot access this page due to Chrome security restrictions');
  }
});

// Periodic check to ensure camera status consistency
setInterval(() => {
  if (cameraActive && activeTabId) {
    chrome.tabs.get(activeTabId, (tab) => {
      if (!chrome.runtime.lastError && tab) {
        // Tab still exists, check its camera status
        try {
          chrome.tabs.sendMessage(activeTabId, { 
            action: 'checkAlive' 
          }).catch(() => {
            // Tab might have lost camera connection
            console.log("Tab might have lost camera connection:", activeTabId);
          });
        } catch (e) {
          console.log("Error checking tab camera status:", e);
        }
      } else {
        // Tab no longer exists, look for a new active tab
        activeCameraTabs.delete(activeTabId);
        
        if (activeCameraTabs.size > 0) {
          // Set first available tab as active
          activeTabId = Array.from(activeCameraTabs)[0];
        } else {
          cameraActive = false;
        }
      }
    });
  }
}, 10000); // Check every 10 seconds

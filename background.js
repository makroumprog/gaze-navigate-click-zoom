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
// Store tab focus state to handle tab switching better
let tabFocusState = {};
// Force camera sync across tabs every few seconds
let cameraSyncInterval = null;

// Start global sync interval for camera state
function startCameraSyncInterval() {
  if (cameraSyncInterval) {
    clearInterval(cameraSyncInterval);
  }
  
  cameraSyncInterval = setInterval(() => {
    if (cameraActive) {
      // Sync camera state across all active tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          // Skip chrome:// and other restricted URLs
          if (!tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
            try {
              chrome.tabs.sendMessage(tab.id, {
                action: 'syncCameraState',
                shouldBeActive: activeCameraTabs.has(tab.id) || (tab.active && cameraActive)
              }).catch(() => {
                // Tab might not have content script yet
              });
            } catch (e) {
              // Ignore errors for tabs without content script
            }
          }
        });
      });
    }
  }, 2000); // Check every 2 seconds
}

// Start the sync interval immediately
startCameraSyncInterval();

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
        tabFocusState[sender.tab.id] = true; // Mark this tab as focused
        console.log("Camera activated in tab:", sender.tab.id);
        console.log("Active camera tabs:", Array.from(activeCameraTabs));
      } else {
        activeCameraTabs.delete(sender.tab.id);
        delete tabFocusState[sender.tab.id]; // Remove tab from focus state
        console.log("Camera deactivated in tab:", sender.tab.id);
        console.log("Active camera tabs:", Array.from(activeCameraTabs));
      }
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Heartbeat handler to keep camera state in sync
  if (request.action === 'heartbeat') {
    const tabHasCamera = sender.tab && activeCameraTabs.has(sender.tab.id);
    
    // If tab says it has camera but background doesn't know, update background
    if (request.hasCameraActive && sender.tab && !tabHasCamera) {
      activeCameraTabs.add(sender.tab.id);
      cameraActive = true;
      console.log("Heartbeat: Adding tab to active camera tabs:", sender.tab.id);
    }
    
    // If tab says it doesn't have camera but background thinks it does, sync
    if (!request.hasCameraActive && tabHasCamera) {
      // This might be a false negative during page transitions, so don't remove yet
      // Just notify the tab that it should have camera active
      console.log("Heartbeat: Tab should have camera but doesn't:", sender.tab.id);
      sendResponse({
        shouldHaveCamera: true,
        globalCameraActive: cameraActive
      });
      return true;
    }
    
    sendResponse({
      shouldHaveCamera: tabHasCamera || (sender.tab && sender.tab.active && cameraActive),
      globalCameraActive: cameraActive
    });
    return true;
  }
  
  // New handler for tabs requesting camera status
  if (request.action === 'checkCameraStatus') {
    const tabHasCamera = sender.tab && activeCameraTabs.has(sender.tab.id);
    const shouldActivate = cameraActive && (sender.tab && sender.tab.active && !tabHasCamera) || request.forceCheck;
    
    sendResponse({ 
      cameraActive: cameraActive,
      shouldActivate: shouldActivate,
      wasTabActive: tabFocusState[sender.tab?.id] || false,
      activeTabID: activeTabId,
      currentTabID: sender.tab?.id
    });
    return true;
  }
  
  // Handle forced camera activation
  if (request.action === 'forceCameraActivation') {
    if (sender.tab) {
      cameraActive = true;
      activeCameraTabs.add(sender.tab.id);
      activeTabId = sender.tab.id;
      tabFocusState[sender.tab.id] = true;
      console.log("Forced camera activation in tab:", sender.tab.id);
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Handle tab focus notification
  if (request.action === 'tabFocused') {
    if (sender.tab) {
      tabFocusState[sender.tab.id] = true;
      console.log("Tab focus registered:", sender.tab.id);
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Handle tab blur notification
  if (request.action === 'tabBlurred') {
    if (sender.tab) {
      tabFocusState[sender.tab.id] = false;
      console.log("Tab blur registered:", sender.tab.id);
    }
    sendResponse({ success: true });
    return true;
  }
});

// Track tab changes - enhanced for better persistence
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Check if camera is active somewhere
  if (cameraActive) {
    console.log(`Tab change detected: ${activeTabId} -> ${activeInfo.tabId}`);
    console.log("Active camera tabs:", Array.from(activeCameraTabs));
    
    // Improved camera restoration logic
    try {
      // Notify the previous tab that it's no longer in focus
      if (activeTabId && activeTabId !== activeInfo.tabId) {
        chrome.tabs.sendMessage(activeTabId, {
          action: 'tabBlur'
        }).catch(error => {
          console.log("Error notifying previous tab:", error);
        });
      }
      
      // Notify the new tab that it's now in focus and should restore camera
      chrome.tabs.sendMessage(activeInfo.tabId, {
        action: 'tabFocus',
        shouldRestoreCamera: activeCameraTabs.has(activeInfo.tabId) || cameraActive,
        previousTabId: activeTabId
      }).catch(error => {
        // This error often occurs if tab doesn't have content script yet
        console.log("Cannot restore camera on new tab:", error);
      });
      
      activeTabId = activeInfo.tabId;
      tabFocusState[activeInfo.tabId] = true;
      
      // Force camera activation in this tab if needed
      if (cameraActive && !activeCameraTabs.has(activeInfo.tabId)) {
        // Wait a moment for tab to fully activate
        setTimeout(() => {
          try {
            chrome.tabs.sendMessage(activeInfo.tabId, {
              action: 'forceActivateCamera',
              previousTabId: activeTabId
            }).catch(() => {});
          } catch (e) {}
        }, 500);
      }
    } catch (e) {
      console.error("Error sending restore camera message:", e);
    }
  }
});

// Handle tab closing
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCameraTabs.has(tabId)) {
    activeCameraTabs.delete(tabId);
    delete tabFocusState[tabId];
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
        try {
          chrome.tabs.sendMessage(tabId, {
            action: 'tabFocus',
            shouldRestoreCamera: true,
            wasActive: tabFocusState[tabId] || false
          }).catch(() => {
            console.log(`Tab ${tabId} updated but couldn't restore camera`);
          });
        } catch (e) {
          console.log(`Error sending message to tab ${tabId}:`, e);
        }
      }, 500); // Short delay to allow content script to initialize
      
      // Try again after a longer delay as a fallback
      setTimeout(() => {
        try {
          chrome.tabs.sendMessage(tabId, {
            action: 'forceActivateCamera'
          }).catch(() => {});
        } catch (e) {}
      }, 2000);
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

// More aggressive periodic check to ensure camera status consistency
setInterval(() => {
  if (cameraActive) {
    // Check all tabs that should have camera active
    Array.from(activeCameraTabs).forEach(tabId => {
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          // Tab still exists, check its camera status
          try {
            chrome.tabs.sendMessage(tabId, { 
              action: 'checkAlive',
              forceRestore: true // Force camera restore if needed
            }).catch(() => {
              // Tab might have lost camera connection
              console.log("Tab might have lost camera connection:", tabId);
            });
          } catch (e) {
            console.log("Error checking tab camera status:", e);
          }
        } else {
          // Tab no longer exists, remove from tracking
          activeCameraTabs.delete(tabId);
          delete tabFocusState[tabId];
        }
      });
    });
    
    // If no active tabs, but camera should be active, check current tab
    if (activeCameraTabs.size === 0 && activeTabId) {
      chrome.tabs.get(activeTabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          try {
            chrome.tabs.sendMessage(activeTabId, {
              action: 'tabFocus',
              shouldRestoreCamera: true
            }).catch(() => {});
          } catch (e) {}
        }
      });
    }
    
    // Get current active tab and ensure it has camera if global state is active
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        const currentTab = tabs[0].id;
        if (!activeCameraTabs.has(currentTab)) {
          try {
            chrome.tabs.sendMessage(currentTab, {
              action: 'forceActivateCamera'
            }).catch(() => {});
          } catch (e) {}
        }
      }
    });
  }
}, 3000); // Check more frequently (every 3 seconds)

// Add event listener for window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE && cameraActive) {
    // When window gets focus, check active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        const currentTabId = tabs[0].id;
        if (currentTabId) {
          activeTabId = currentTabId;
          
          // Try to restore camera in current tab
          try {
            chrome.tabs.sendMessage(currentTabId, {
              action: 'tabFocus',
              shouldRestoreCamera: true,
              forceActivate: true
            }).catch(() => {});
          } catch (e) {}
          
          // Try again after a short delay
          setTimeout(() => {
            try {
              chrome.tabs.sendMessage(currentTabId, {
                action: 'forceActivateCamera'
              }).catch(() => {});
            } catch (e) {}
          }, 1000);
        }
      }
    });
  }
});

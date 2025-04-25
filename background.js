
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
// Track the last active window to handle window switching
let lastActiveWindowId = null;
// Add a more reliable persistence flag
let forceCameraPersistence = true;

// Start global sync interval for camera state with improved reliability
function startCameraSyncInterval() {
  if (cameraSyncInterval) {
    clearInterval(cameraSyncInterval);
  }
  
  cameraSyncInterval = setInterval(() => {
    if (cameraActive) {
      // Sync camera state across all active tabs with improved error handling
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          // Skip chrome:// and other restricted URLs
          if (!tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
            try {
              chrome.tabs.sendMessage(tab.id, {
                action: 'syncCameraState',
                shouldBeActive: activeCameraTabs.has(tab.id) || (tab.active && cameraActive),
                forcePersistence: forceCameraPersistence
              }).catch(() => {
                // Silent catch for tabs without content script
              });
            } catch (e) {
              // Ignore errors for tabs without content script
            }
          }
        });
      });
    }
  }, 500); // Check more frequently (every 500ms)
}

// Start the sync interval immediately
startCameraSyncInterval();

// Enhanced ultra-persistent cross-tab camera state synchronization
setInterval(() => {
  // Check each active tab for camera status and force sync if needed
  if (cameraActive && activeCameraTabs.size > 0) {
    chrome.tabs.query({active: true}, (tabs) => {
      tabs.forEach(tab => {
        if (!tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
          try {
            chrome.tabs.sendMessage(tab.id, {
              action: 'maintainCamera',
              forcePersistence: true,
              globalCameraActive: true
            }).catch(() => {});
          } catch (e) {}
        }
      });
    });
  }
}, 300);

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.sync.get(null, (settings) => {
      sendResponse(settings);
    });
    return true; // Required for asynchronous sendResponse
  }

  // Camera status update handler - enhanced with debouncing and better persistence
  if (request.action === 'cameraStatusUpdate') {
    const now = Date.now();
    // Prevent rapid camera status changes (debounce)
    if (now - lastCameraActivationTime < 500) { // Reduced to be more responsive
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
        
        // Mark this for extreme persistence
        if (request.requiresPersistence) {
          forceCameraPersistence = true;
        }
        
        // When camera is activated in one tab, mark it for restoration in all other tabs
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (tab.active && tab.id !== sender.tab.id && !tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
              try {
                chrome.tabs.sendMessage(tab.id, {
                  action: 'prepareForCameraActivation'
                }).catch(() => {});
              } catch (e) {}
            }
          });
        });
      } else {
        activeCameraTabs.delete(sender.tab.id);
        delete tabFocusState[sender.tab.id]; // Remove tab from focus state
        console.log("Camera deactivated in tab:", sender.tab.id);
      }
      console.log("Active camera tabs:", Array.from(activeCameraTabs));
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Heartbeat handler with more aggressive camera restoration
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
      console.log("Heartbeat: Tab should have camera but doesn't:", sender.tab.id);
      sendResponse({
        shouldHaveCamera: true,
        globalCameraActive: cameraActive,
        forceRestore: true, // Always force restore
        forcePersistence: forceCameraPersistence
      });
      return true;
    }
    
    sendResponse({
      shouldHaveCamera: tabHasCamera || (sender.tab && sender.tab.active && cameraActive),
      globalCameraActive: cameraActive,
      forceRestore: true, // Always force restore
      forcePersistence: forceCameraPersistence
    });
    return true;
  }
  
  // New handler for tabs requesting camera status - enhanced for more reliability
  if (request.action === 'checkCameraStatus') {
    const tabHasCamera = sender.tab && activeCameraTabs.has(sender.tab.id);
    const shouldActivate = cameraActive && (
      (sender.tab && sender.tab.active && !tabHasCamera) || 
      request.forceCheck || 
      tabFocusState[sender.tab?.id] ||
      forceCameraPersistence
    );
    
    sendResponse({ 
      cameraActive: cameraActive,
      shouldActivate: shouldActivate,
      wasTabActive: tabFocusState[sender.tab?.id] || false,
      activeTabID: activeTabId,
      currentTabID: sender.tab?.id,
      forceRestore: true, // Always force restore
      forcePersistence: forceCameraPersistence
    });
    return true;
  }
  
  // Handle forced camera activation with more aggressive propagation to other tabs
  if (request.action === 'forceCameraActivation') {
    if (sender.tab) {
      cameraActive = true;
      activeCameraTabs.add(sender.tab.id);
      activeTabId = sender.tab.id;
      tabFocusState[sender.tab.id] = true;
      forceCameraPersistence = true; // Always force persistence
      console.log("Forced camera activation in tab:", sender.tab.id);
      
      // Attempt to activate in any other visible tabs as well
      chrome.tabs.query({active: true}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id !== sender.tab.id && !tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
            try {
              chrome.tabs.sendMessage(tab.id, {
                action: 'forceActivateCamera',
                source: 'propagation',
                forcePersistence: true
              }).catch(() => {});
            } catch (e) {}
          }
        });
      });
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Handle calibration completion - NEW
  if (request.action === 'calibrationCompleted') {
    console.log("Calibration completed, ensuring camera stays active");
    
    if (sender.tab) {
      // Save calibration data to storage
      chrome.storage.sync.set({
        calibrated: true,
        calibrationData: request.calibrationData || []
      });
      
      // Force all tabs to maintain camera
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (!tab.url.match(/^(chrome:\/\/|chrome-extension:\/\/|file:\/\/)/)) {
            try {
              chrome.tabs.sendMessage(tab.id, {
                action: 'maintainCamera',
                afterCalibration: true,
                forcePersistence: true
              }).catch(() => {});
            } catch (e) {}
          }
        });
      });
      
      // Activate extreme persistence mode
      forceCameraPersistence = true;
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

// Track tab changes - enhanced for better persistence and immediate restoration
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Check if camera is active somewhere
  if (cameraActive) {
    console.log(`Tab change detected: ${activeTabId} -> ${activeInfo.tabId}`);
    console.log("Active camera tabs:", Array.from(activeCameraTabs));
    
    // Improved camera restoration logic
    try {
      // Notify the previous tab that it's no longer in focus (but don't stop camera)
      if (activeTabId && activeTabId !== activeInfo.tabId) {
        chrome.tabs.sendMessage(activeTabId, {
          action: 'tabBlur',
          keepCameraAlive: true // Added flag to keep camera alive
        }).catch(() => {});
      }
      
      // IMMEDIATELY try to notify the new tab to restore camera - don't wait
      chrome.tabs.sendMessage(activeInfo.tabId, {
        action: 'tabFocus',
        shouldRestoreCamera: activeCameraTabs.has(activeInfo.tabId) || cameraActive,
        previousTabId: activeTabId,
        forceActivate: true, // Always force activate on tab change
        forcePersistence: true // Always force persistence
      }).catch(() => {
        // Try again with extremely short delays to catch the tab as soon as possible
        [50, 100, 200, 300, 500, 1000].forEach(delay => {
          setTimeout(() => {
            try {
              chrome.tabs.sendMessage(activeInfo.tabId, {
                action: 'forceActivateCamera',
                urgent: true,
                forcePersistence: true
              }).catch(() => {});
            } catch (e) {}
          }, delay);
        });
      });
      
      activeTabId = activeInfo.tabId;
      tabFocusState[activeInfo.tabId] = true;
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

// Track visibility changes - enhanced with proper error handling and aggressive restoration
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    // If tab has been fully loaded
    if (activeCameraTabs.has(tabId) || (cameraActive && tabId === activeTabId)) {
      console.log(`Tab ${tabId} updated to complete state, attempting to restore camera`);
      
      // Try to restore camera with multiple attempts at different delays
      [100, 300, 600, 1200, 2500].forEach(delay => {
        setTimeout(() => {
          try {
            chrome.tabs.sendMessage(tabId, {
              action: 'tabFocus',
              shouldRestoreCamera: true,
              wasActive: tabFocusState[tabId] || false,
              forceActivate: true,
              attempt: delay
            }).catch(() => {});
          } catch (e) {}
        }, delay);
      });
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
              forceRestore: true, // Always force camera restore
              forcePersistence: true // Always force persistence
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
    
    // Make sure current active tab has camera
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        const currentTab = tabs[0].id;
        try {
          chrome.tabs.sendMessage(currentTab, {
            action: 'forceActivateCamera',
            priority: 'high',
            forcePersistence: true
          }).catch(() => {});
        } catch (e) {}
      }
    });
  }
}, 1000); // More frequent checking (every 1 second)

// Enhanced window focus handler to better handle switching between windows
chrome.windows.onFocusChanged.addListener((windowId) => {
  // Record last active window
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    lastActiveWindowId = windowId;
  }
  
  if (windowId !== chrome.windows.WINDOW_ID_NONE && cameraActive) {
    // When window gets focus, check active tab with multiple restoration attempts
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        const currentTabId = tabs[0].id;
        if (currentTabId) {
          activeTabId = currentTabId;
          
          // Try to restore camera immediately
          try {
            chrome.tabs.sendMessage(currentTabId, {
              action: 'tabFocus',
              shouldRestoreCamera: true,
              forceActivate: true,
              windowFocus: true
            }).catch(() => {});
          } catch (e) {}
          
          // Try multiple times with increasing delays
          [200, 500, 1000, 2000].forEach(delay => {
            setTimeout(() => {
              try {
                chrome.tabs.sendMessage(currentTabId, {
                  action: 'forceActivateCamera',
                  windowFocus: true,
                  attempt: delay
                }).catch(() => {});
              } catch (e) {}
            }, delay);
          });
        }
      }
    });
  }
});

// Additional handler for window creation to handle new windows better
chrome.windows.onCreated.addListener((window) => {
  if (cameraActive) {
    setTimeout(() => {
      chrome.tabs.query({ active: true, windowId: window.id }, (tabs) => {
        if (tabs.length > 0) {
          try {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'forceActivateCamera',
              newWindow: true
            }).catch(() => {});
          } catch (e) {}
        }
      });
    }, 500);
  }
});

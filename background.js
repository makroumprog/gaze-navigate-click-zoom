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
      gazeSensitivity: 5,
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

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.sync.get(null, (settings) => {
      sendResponse(settings);
    });
    return true; // Required for asynchronous sendResponse
  }

  // Camera status update handler
  if (request.action === 'cameraStatusUpdate') {
    cameraActive = request.isActive;
    if (sender.tab) {
      activeTabId = sender.tab.id;
      if (request.isActive) {
        activeCameraTabs.add(sender.tab.id);
      } else {
        activeCameraTabs.delete(sender.tab.id);
      }
    }
    sendResponse({ success: true });
    return true;
  }
});

// Track tab changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  // If camera is active somewhere, notify the new tab to restore it
  if (cameraActive && activeTabId !== activeInfo.tabId) {
    chrome.tabs.sendMessage(activeInfo.tabId, {
      action: 'restoreCamera',
      shouldRestore: true
    }).catch(error => {
      // This error often occurs if tab doesn't have content script yet
      console.log("Cannot restore camera on new tab:", error);
    });
    activeTabId = activeInfo.tabId;
  }
});

// Handle tab closing
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeCameraTabs.has(tabId)) {
    activeCameraTabs.delete(tabId);
    // If this was the last tab with camera, update global state
    if (activeCameraTabs.size === 0) {
      cameraActive = false;
    }
  }
});

// Track visibility changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && activeCameraTabs.has(tabId)) {
    // If this tab had camera active, try to restore it
    chrome.tabs.sendMessage(tabId, {
      action: 'restoreCamera',
      shouldRestore: true
    }).catch(() => {
      console.log("Tab updated but couldn't restore camera");
    });
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


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

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.sync.get(null, (settings) => {
      sendResponse(settings);
    });
    return true; // Required for asynchronous sendResponse
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

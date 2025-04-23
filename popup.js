
document.addEventListener('DOMContentLoaded', function() {
  // Elements
  const calibrateBtn = document.getElementById('calibrate-btn');
  const toggleBtn = document.getElementById('toggle-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const modal = document.getElementById('calibration-modal');
  const startCalibrationBtn = document.getElementById('start-calibration');
  const cancelCalibrationBtn = document.getElementById('cancel-calibration');
  const helpBtn = document.getElementById('help-btn');
  const advancedBtn = document.getElementById('advanced-btn');
  
  // Feature toggles
  const gazeCursor = document.getElementById('gaze-cursor');
  const blinkClick = document.getElementById('blink-click');
  const autoZoom = document.getElementById('auto-zoom');
  const textSpeech = document.getElementById('text-speech');
  const edgeNavigation = document.getElementById('edge-navigation');
  const autoScroll = document.getElementById('auto-scroll');
  
  // Sensitivity sliders
  const gazeSensitivity = document.getElementById('gaze-sensitivity');
  const blinkDelay = document.getElementById('blink-delay');
  const zoomDelay = document.getElementById('zoom-delay');
  const speechRate = document.getElementById('speech-rate');
  const edgeSize = document.getElementById('edge-size');
  const scrollSpeed = document.getElementById('scroll-speed');
  
  // Current extension state
  let isActive = true;

  // Load saved settings
  chrome.storage.sync.get({
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
    scrollSpeed: 5
  }, function(items) {
    isActive = items.isActive;
    updateStatusUI(isActive);
    
    // Set toggle states
    gazeCursor.checked = items.gazeCursor;
    blinkClick.checked = items.blinkClick;
    autoZoom.checked = items.autoZoom;
    textSpeech.checked = items.textSpeech;
    edgeNavigation.checked = items.edgeNavigation;
    autoScroll.checked = items.autoScroll;
    
    // Set slider values
    gazeSensitivity.value = items.gazeSensitivity;
    blinkDelay.value = items.blinkDelay;
    zoomDelay.value = items.zoomDelay;
    speechRate.value = items.speechRate;
    edgeSize.value = items.edgeSize;
    scrollSpeed.value = items.scrollSpeed;
  });

  // Toggle extension active state
  toggleBtn.addEventListener('click', function() {
    isActive = !isActive;
    updateStatusUI(isActive);
    saveSettings();
    
    // Notify content scripts of state change
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'toggleExtension',
        isActive: isActive
      });
    });
  });
  
  // Open calibration modal
  calibrateBtn.addEventListener('click', function() {
    modal.style.display = 'block';
    initializeCalibration();
  });
  
  // Start calibration process
  startCalibrationBtn.addEventListener('click', function() {
    startCalibration();
  });
  
  // Close calibration modal
  cancelCalibrationBtn.addEventListener('click', function() {
    modal.style.display = 'none';
    stopCalibration();
  });
  
  // Event listeners for toggles
  gazeCursor.addEventListener('change', saveSettings);
  blinkClick.addEventListener('change', saveSettings);
  autoZoom.addEventListener('change', saveSettings);
  textSpeech.addEventListener('change', saveSettings);
  edgeNavigation.addEventListener('change', saveSettings);
  autoScroll.addEventListener('change', saveSettings);
  
  // Event listeners for sliders
  gazeSensitivity.addEventListener('change', saveSettings);
  blinkDelay.addEventListener('change', saveSettings);
  zoomDelay.addEventListener('change', saveSettings);
  speechRate.addEventListener('change', saveSettings);
  edgeSize.addEventListener('change', saveSettings);
  scrollSpeed.addEventListener('change', saveSettings);
  
  // Help button
  helpBtn.addEventListener('click', function() {
    chrome.tabs.create({
      url: 'help.html'
    });
  });
  
  // Advanced settings button
  advancedBtn.addEventListener('click', function() {
    chrome.tabs.create({
      url: 'advanced.html'
    });
  });
  
  // Update UI based on active state
  function updateStatusUI(active) {
    if (active) {
      statusIndicator.className = 'active';
      statusText.textContent = 'Actif';
      toggleBtn.textContent = 'Désactiver';
    } else {
      statusIndicator.className = 'inactive';
      statusText.textContent = 'Inactif';
      toggleBtn.textContent = 'Activer';
    }
  }
  
  // Save all settings to Chrome storage
  function saveSettings() {
    chrome.storage.sync.set({
      isActive: isActive,
      gazeCursor: gazeCursor.checked,
      blinkClick: blinkClick.checked,
      autoZoom: autoZoom.checked,
      textSpeech: textSpeech.checked,
      edgeNavigation: edgeNavigation.checked,
      autoScroll: autoScroll.checked,
      gazeSensitivity: parseInt(gazeSensitivity.value),
      blinkDelay: parseInt(blinkDelay.value),
      zoomDelay: parseInt(zoomDelay.value),
      speechRate: parseFloat(speechRate.value),
      edgeSize: parseInt(edgeSize.value),
      scrollSpeed: parseInt(scrollSpeed.value)
    }, function() {
      // Notify content scripts of settings change
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'settingsUpdated'
          });
        }
      });
    });
  }
  
  // Calibration functions
  let webcam, faceOverlayCanvas, faceOverlayCtx, calibrationTarget;
  let calibrationPoints = [];
  let currentPoint = 0;
  
  function initializeCalibration() {
    webcam = document.getElementById('webcam');
    faceOverlayCanvas = document.getElementById('face-overlay');
    calibrationTarget = document.getElementById('calibration-target');
    
    faceOverlayCtx = faceOverlayCanvas.getContext('2d');
    
    // Set up calibration points (corners and center)
    calibrationPoints = [
      {x: '50%', y: '50%'}, // Center
      {x: '20%', y: '20%'}, // Top-left
      {x: '80%', y: '20%'}, // Top-right
      {x: '20%', y: '80%'}, // Bottom-left
      {x: '80%', y: '80%'}, // Bottom-right
    ];
    
    // Position first point
    positionCalibrationPoint(0);
  }
  
  function startCalibration() {
    // Request webcam access
    navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }
    })
    .then(stream => {
      webcam.srcObject = stream;
      
      currentPoint = 0;
      positionCalibrationPoint(currentPoint);
      
      // Update instructions
      document.getElementById('calibration-instructions').textContent = 
        'Fixez le point pendant 2 secondes';
        
      // Change button text
      startCalibrationBtn.textContent = 'Suivant';
      
      // Update button event handler
      startCalibrationBtn.removeEventListener('click', startCalibration);
      startCalibrationBtn.addEventListener('click', nextCalibrationPoint);
    })
    .catch(error => {
      console.error('Erreur d\'accès à la caméra:', error);
      document.getElementById('calibration-instructions').textContent = 
        'Erreur: Impossible d\'accéder à la caméra. Vérifiez les permissions.';
    });
  }
  
  function positionCalibrationPoint(index) {
    if (index < calibrationPoints.length) {
      calibrationTarget.style.left = calibrationPoints[index].x;
      calibrationTarget.style.top = calibrationPoints[index].y;
    }
  }
  
  function nextCalibrationPoint() {
    // Here we would normally save the eye position data for this point
    // For simplicity, we'll just move to the next point
    
    currentPoint++;
    
    if (currentPoint >= calibrationPoints.length) {
      // Calibration complete
      document.getElementById('calibration-instructions').textContent = 
        'Calibration terminée!';
      
      // Simulate saving calibration data
      setTimeout(() => {
        modal.style.display = 'none';
        stopCalibration();
        
        // Reset for next time
        startCalibrationBtn.textContent = 'Commencer';
        startCalibrationBtn.removeEventListener('click', nextCalibrationPoint);
        startCalibrationBtn.addEventListener('click', startCalibration);
      }, 1000);
    } else {
      positionCalibrationPoint(currentPoint);
    }
  }
  
  function stopCalibration() {
    // Stop webcam if it's running
    if (webcam && webcam.srcObject) {
      webcam.srcObject.getTracks().forEach(track => track.stop());
      webcam.srcObject = null;
    }
    
    // Reset calibration UI
    document.getElementById('calibration-instructions').textContent = 
      'Regardez le point et suivez-le des yeux';
      
    startCalibrationBtn.textContent = 'Commencer';
    startCalibrationBtn.removeEventListener('click', nextCalibrationPoint);
    startCalibrationBtn.addEventListener('click', startCalibration);
  }
});

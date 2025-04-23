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
  let gazeDwellTimer = null;
  let currentCalibrationData = [];
  let isCalibrating = false;
  
  function initializeCalibration() {
    webcam = document.getElementById('webcam');
    faceOverlayCanvas = document.getElementById('face-overlay');
    calibrationTarget = document.getElementById('calibration-target');
    
    faceOverlayCtx = faceOverlayCanvas.getContext('2d');
    
    // Reset calibration state
    currentPoint = 0;
    isCalibrating = false;
    currentCalibrationData = [];
    
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
      webcam.onloadedmetadata = function() {
        webcam.play();
        
        currentPoint = 0;
        positionCalibrationPoint(currentPoint);
        
        // Update instructions
        document.getElementById('calibration-instructions').textContent = 
          'Fixez le point pendant 2 secondes';
          
        // Change button text
        startCalibrationBtn.textContent = 'Suivant';
        
        // Start gaze tracking if we had a face detection API
        isCalibrating = true;
        
        // Update button event handler
        startCalibrationBtn.removeEventListener('click', startCalibration);
        startCalibrationBtn.addEventListener('click', nextCalibrationPoint);
        
        // Start a simulated gaze dwell counter for demonstration
        // In a real implementation, this would be triggered by actual eye tracking
        simulateGazeDwell();
      };
    })
    .catch(error => {
      console.error('Erreur d\'accès à la caméra:', error);
      document.getElementById('calibration-instructions').textContent = 
        'Erreur: Impossible d\'accéder à la caméra. Vérifiez les permissions.';
    });
  }
  
  // Add a simulated gaze dwell detection
  function simulateGazeDwell() {
    if (!isCalibrating) return;
    
    // Visual feedback - change target color to indicate dwell progress
    let startTime = Date.now();
    let dwellRequired = 2000; // 2 seconds
    
    // Add visual indicator for dwell time
    let dwellIndicator = document.createElement('div');
    dwellIndicator.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background-color: rgba(44, 123, 229, 0.3);
      transform: scale(0);
      transition: transform 2s linear;
    `;
    calibrationTarget.appendChild(dwellIndicator);
    
    // Start animation after a small delay
    setTimeout(() => {
      dwellIndicator.style.transform = 'scale(1)';
    }, 50);
    
    // After 2 seconds, highlight the button to indicate ready to proceed
    gazeDwellTimer = setTimeout(() => {
      // Visual feedback that dwell is complete
      calibrationTarget.style.backgroundColor = 'rgba(0, 217, 126, 0.8)';
      startCalibrationBtn.classList.add('highlight');
      
      // Save simulated calibration data for this point
      currentCalibrationData.push({
        point: currentPoint,
        x: calibrationPoints[currentPoint].x,
        y: calibrationPoints[currentPoint].y,
        // In a real implementation, we would store actual eye position data
        eyeData: { x: Math.random() * 100, y: Math.random() * 100 }
      });
      
      // Update instruction to click next
      document.getElementById('calibration-instructions').textContent = 
        'Cliquez sur Suivant pour continuer';
      
    }, dwellRequired);
  }
  
  function positionCalibrationPoint(index) {
    if (index < calibrationPoints.length) {
      calibrationTarget.style.left = calibrationPoints[index].x;
      calibrationTarget.style.top = calibrationPoints[index].y;
      
      // Reset target appearance
      calibrationTarget.style.backgroundColor = 'rgba(44, 123, 229, 0.8)';
      
      // Remove any old dwell indicators
      while (calibrationTarget.firstChild) {
        calibrationTarget.removeChild(calibrationTarget.firstChild);
      }
      
      // Remove highlight from button
      startCalibrationBtn.classList.remove('highlight');
    }
  }
  
  function nextCalibrationPoint() {
    // Clear any pending timers
    if (gazeDwellTimer) {
      clearTimeout(gazeDwellTimer);
      gazeDwellTimer = null;
    }
    
    currentPoint++;
    
    if (currentPoint >= calibrationPoints.length) {
      // Calibration complete
      document.getElementById('calibration-instructions').textContent = 
        'Calibration terminée!';
      
      // Save calibration data to storage
      chrome.storage.sync.set({
        calibrated: true,
        calibrationData: currentCalibrationData
      });
      
      // Visual feedback of completion
      calibrationTarget.style.backgroundColor = 'rgba(0, 217, 126, 0.8)';
      
      // Close modal after a short delay
      setTimeout(() => {
        modal.style.display = 'none';
        stopCalibration();
        
        // Reset for next time
        startCalibrationBtn.textContent = 'Commencer';
        startCalibrationBtn.removeEventListener('click', nextCalibrationPoint);
        startCalibrationBtn.addEventListener('click', startCalibration);
      }, 1500);
    } else {
      // Move to next point
      positionCalibrationPoint(currentPoint);
      
      // Reset instruction
      document.getElementById('calibration-instructions').textContent = 
        'Fixez le point pendant 2 secondes';
      
      // Start tracking for next point
      simulateGazeDwell();
    }
  }
  
  function stopCalibration() {
    // Stop webcam if it's running
    if (webcam && webcam.srcObject) {
      webcam.srcObject.getTracks().forEach(track => track.stop());
      webcam.srcObject = null;
    }
    
    // Reset calibration state
    isCalibrating = false;
    if (gazeDwellTimer) {
      clearTimeout(gazeDwellTimer);
      gazeDwellTimer = null;
    }
    
    // Reset calibration UI
    document.getElementById('calibration-instructions').textContent = 
      'Regardez le point et suivez-le des yeux';
      
    startCalibrationBtn.textContent = 'Commencer';
    startCalibrationBtn.classList.remove('highlight');
    startCalibrationBtn.removeEventListener('click', nextCalibrationPoint);
    startCalibrationBtn.addEventListener('click', startCalibration);
  }
});

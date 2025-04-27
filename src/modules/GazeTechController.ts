
import GazeTechUI from './ui/GazeTechUI';
import CameraManager from './camera/CameraManager';
import EyeTracker from './tracking/EyeTracker';
import type { CameraState } from './camera/CameraManager';
import type { GazePoint } from './tracking/EyeTracker';

export interface GazeTechSettings {
  debugMode?: boolean;
  sensitivity?: number;
  smoothingFactor?: number;
  calibrationData?: any;
}

export class GazeTechController {
  private ui: GazeTechUI;
  private cameraManager: CameraManager;
  private eyeTracker: EyeTracker;
  private isActive: boolean = true;
  private faceMesh: any = null;
  private persistenceInterval: number | null = null; // For maintaining camera state
  
  constructor(private settings: GazeTechSettings = {}) {
    this.ui = new GazeTechUI(settings.debugMode);
    
    // Initialize eye tracker with settings
    this.eyeTracker = new EyeTracker({
      sensitivity: settings.sensitivity || 9,
      smoothingFactor: settings.smoothingFactor || 0.05,
      calibrationData: settings.calibrationData
    });
  }

  async initialize() {
    // Initialize UI
    this.ui.initialize();
    const elements = this.ui.getElements();
    
    if (!elements.video) {
      throw new Error('Failed to initialize video element');
    }

    // Initialize camera manager
    this.cameraManager = new CameraManager(
      elements.video,
      this.handleCameraStateChange.bind(this)
    );

    // Load face mesh model
    if (window.facemesh) {
      this.faceMesh = await window.facemesh.load({
        maxFaces: 1,
        refineLandmarks: true,
        detectionConfidence: 0.9,
        predictIrises: true
      });
    }

    // Start tracking loop
    this.startTracking();
    
    // Start camera persistence check
    this.startPersistenceCheck();
    
    // Assurer que le curseur est visible au démarrage
    this.ui.showCursor(this.isActive);
  }

  private handleCameraStateChange(state: CameraState) {
    this.ui.updateStatusIndicator(state.isInitialized);
  }

  private async startTracking() {
    if (!this.faceMesh) {
      requestAnimationFrame(this.startTracking.bind(this));
      return;
    }

    try {
      const elements = this.ui.getElements();
      if (!elements.video) return;

      const predictions = await this.faceMesh.estimateFaces({
        input: elements.video,
        flipHorizontal: false,
        predictIrises: true
      });

      if (predictions.length > 0) {
        const trackingResult = this.eyeTracker.processEyeData(predictions[0]);
        if (this.isActive) {
          this.ui.updateCursorPosition(trackingResult.gazePoint.x, trackingResult.gazePoint.y);
          this.ui.updateStatusIndicator(true);
          this.ui.showCursor(true); // Assurer que le curseur est visible pendant le suivi
        }
      } else {
        this.ui.updateStatusIndicator(false);
      }
    } catch (error) {
      console.error('Tracking error:', error);
      this.ui.updateStatusIndicator(false);
    }

    requestAnimationFrame(this.startTracking.bind(this));
  }

  // Méthode améliorée pour maintenir la caméra et le suivi persistants
  private startPersistenceCheck() {
    // Clear any existing interval
    if (this.persistenceInterval !== null) {
      clearInterval(this.persistenceInterval);
    }
    
    // Set up interval to check and maintain camera connection
    this.persistenceInterval = window.setInterval(() => {
      if (this.isActive) {
        this.restoreCamera(true);
        this.ui.showCursor(true);
      }
    }, 500) as any; // Plus fréquent pour une meilleure réactivité
    
    // Also add visibility change listener for more reliable restoration
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isActive) {
        this.restoreCamera(true);
        this.ui.showCursor(true);
      }
    });
  }

  public async restoreCamera(force: boolean = false) {
    if (!this.isActive) return false;
    
    const result = await this.cameraManager.initialize(force);
    if (result) {
      this.ui.showCursor(true);
    }
    return result;
  }
  
  public updateCalibrationData(calibrationData: any) {
    this.eyeTracker.updateCalibrationData(calibrationData);
    console.log('Calibration data updated:', calibrationData);
    
    // Assurez-vous que le suivi est actif après la mise à jour de la calibration
    this.setActive(true);
  }
  
  public setActive(active: boolean) {
    console.log('GazeTech tracking active state:', active);
    this.isActive = active;
    this.eyeTracker.setActive(active);
    this.ui.showCursor(active);
    
    if (active) {
      // Ensure camera is running when activated
      this.restoreCamera(true);
    }
  }

  public cleanup() {
    this.isActive = false;
    
    if (this.persistenceInterval !== null) {
      clearInterval(this.persistenceInterval);
      this.persistenceInterval = null;
    }
    
    this.cameraManager.cleanup();
    this.ui.showCursor(false);
  }
}

export default GazeTechController;

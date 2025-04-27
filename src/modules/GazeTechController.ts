
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
  }

  private handleCameraStateChange(state: CameraState) {
    this.ui.updateStatusIndicator(state.isInitialized);
  }

  private async startTracking() {
    if (!this.isActive || !this.faceMesh) {
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
        this.ui.updateCursorPosition(trackingResult.gazePoint.x, trackingResult.gazePoint.y);
        this.ui.updateStatusIndicator(true);
      } else {
        this.ui.updateStatusIndicator(false);
      }
    } catch (error) {
      console.error('Tracking error:', error);
      this.ui.updateStatusIndicator(false);
    }

    requestAnimationFrame(this.startTracking.bind(this));
  }

  public async restoreCamera(force: boolean = false) {
    return this.cameraManager.initialize(force);
  }
  
  // Nouvelle méthode pour mettre à jour les données de calibration
  public updateCalibrationData(calibrationData: any) {
    this.eyeTracker.updateCalibrationData(calibrationData);
    console.log('Calibration data updated:', calibrationData);
  }
  
  // Nouvelle méthode pour activer/désactiver le suivi
  public setActive(active: boolean) {
    console.log('GazeTech tracking active state:', active);
    this.isActive = active;
    this.ui.toggleCursorVisibility(active);
  }

  public cleanup() {
    this.isActive = false;
    this.cameraManager.cleanup();
  }
}

export default GazeTechController;

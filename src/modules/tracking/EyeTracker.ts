
export interface GazePoint {
  x: number;
  y: number;
}

export interface EyeTrackerSettings {
  sensitivity: number;
  smoothingFactor: number;
  calibrationData?: any;
}

export class EyeTracker {
  private sensitivity: number;
  private smoothingFactor: number;
  private calibrationData: any;
  private lastGazePoint: GazePoint = { x: 0, y: 0 };
  private isActive: boolean = true; // Active par défaut
  
  constructor(settings: EyeTrackerSettings) {
    this.sensitivity = settings.sensitivity;
    this.smoothingFactor = settings.smoothingFactor;
    this.calibrationData = settings.calibrationData;
  }
  
  public updateCalibrationData(calibrationData: any) {
    this.calibrationData = calibrationData;
    // Activation automatique après une mise à jour des données de calibration
    this.isActive = true;
  }
  
  public setActive(active: boolean) {
    this.isActive = active;
  }
  
  public isTracking(): boolean {
    return this.isActive;
  }
  
  processEyeData(faceData: any) {
    if (!this.isActive) {
      return {
        gazePoint: this.lastGazePoint,
        rawPoint: this.lastGazePoint
      };
    }
    
    // Extract iris positions from face mesh (landmarks 468 and 473)
    const mesh = faceData.scaledMesh;
    
    // Use left and right iris centers (specific indices in the face mesh)
    const leftIris = mesh[468]; // Left iris center
    const rightIris = mesh[473]; // Right iris center
    
    // Average the iris positions to get eye gaze direction
    const irisX = (leftIris[0] + rightIris[0]) / 2;
    const irisY = (leftIris[1] + rightIris[1]) / 2;
    
    // Apply calibration if available
    let calibratedX = irisX;
    let calibratedY = irisY;
    
    if (this.calibrationData) {
      // Amélioration de l'application de la calibration
      try {
        // Apply any calibration transformation
        const centerPoint = this.calibrationData[0]; // Center calibration point
        if (centerPoint && centerPoint.eyeData) {
          // Calculate adjustment based on center calibration with facteur de sensibilité
          const offsetX = (centerPoint.eyeData.x - irisX) * 1.2; // Facteur d'amplification
          const offsetY = (centerPoint.eyeData.y - irisY) * 1.2; // Facteur d'amplification
          calibratedX = irisX + offsetX;
          calibratedY = irisY + offsetY;
        }
      } catch (e) {
        console.error('Error applying calibration data:', e);
      }
    }
    
    // Map the iris position to screen coordinates
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    
    // Use bounding box to normalize coordinates with improved mapping
    const faceWidth = faceData.boundingBox.bottomRight[0] - faceData.boundingBox.topLeft[0];
    const faceHeight = faceData.boundingBox.bottomRight[1] - faceData.boundingBox.topLeft[1];
    
    // Calculate screen position with enhanced sensitivity and improved mapping
    const sensitivityFactor = this.sensitivity / 5; // Ajusté pour une meilleure sensibilité
    const gazeX = screenWidth * (calibratedX / faceWidth) * sensitivityFactor;
    const gazeY = screenHeight * (calibratedY / faceHeight) * sensitivityFactor;
    
    // Apply smoothing for more natural movement with adjustable smoothing factor
    const smoothingFactor = Math.min(0.3, Math.max(0.05, this.smoothingFactor));
    const smoothedX = this.lastGazePoint.x * (1 - smoothingFactor) + gazeX * smoothingFactor;
    const smoothedY = this.lastGazePoint.y * (1 - smoothingFactor) + gazeY * smoothingFactor;
    
    // Update last gaze point
    this.lastGazePoint = { x: smoothedX, y: smoothedY };
    
    return {
      gazePoint: this.lastGazePoint,
      rawPoint: { x: gazeX, y: gazeY }
    };
  }
}

export default EyeTracker;


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
  
  constructor(settings: EyeTrackerSettings) {
    this.sensitivity = settings.sensitivity;
    this.smoothingFactor = settings.smoothingFactor;
    this.calibrationData = settings.calibrationData;
  }
  
  public updateCalibrationData(calibrationData: any) {
    this.calibrationData = calibrationData;
  }
  
  processEyeData(faceData: any) {
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
      // Simple calibration adjustment (real implementation would be more sophisticated)
      // This is a placeholder - in a real system we'd use the calibration points
      // to create a mapping function
      try {
        // Apply any calibration transformation
        const centerPoint = this.calibrationData[0]; // Center calibration point
        if (centerPoint && centerPoint.eyeData) {
          // Calculate adjustment based on center calibration
          const offsetX = centerPoint.eyeData.x - irisX;
          const offsetY = centerPoint.eyeData.y - irisY;
          calibratedX = irisX + offsetX;
          calibratedY = irisY + offsetY;
        }
      } catch (e) {
        console.error('Error applying calibration data:', e);
      }
    }
    
    // Map the iris position to screen coordinates
    // The mapping depends on the face position and size
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    
    // Use bounding box to normalize coordinates
    const faceWidth = faceData.boundingBox.bottomRight[0] - faceData.boundingBox.topLeft[0];
    const faceHeight = faceData.boundingBox.bottomRight[1] - faceData.boundingBox.topLeft[1];
    
    // Calculate screen position with enhanced sensitivity
    // This is a simple linear mapping - could be improved for accuracy
    const gazeX = screenWidth * (calibratedX / faceWidth) * (this.sensitivity / 10);
    const gazeY = screenHeight * (calibratedY / faceHeight) * (this.sensitivity / 10);
    
    // Apply smoothing for more natural movement
    const smoothedX = this.lastGazePoint.x * (1 - this.smoothingFactor) + gazeX * this.smoothingFactor;
    const smoothedY = this.lastGazePoint.y * (1 - this.smoothingFactor) + gazeY * this.smoothingFactor;
    
    // Update last gaze point
    this.lastGazePoint = { x: smoothedX, y: smoothedY };
    
    return {
      gazePoint: this.lastGazePoint,
      rawPoint: { x: gazeX, y: gazeY }
    };
  }
}

export default EyeTracker;

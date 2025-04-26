
export interface GazePoint {
  x: number;
  y: number;
}

export interface EyeState {
  isBlinking: boolean;
  lastBlinkTime: number;
}

export interface TrackingSettings {
  sensitivity: number;
  smoothingFactor: number;
  calibrationData?: any;
}

export class EyeTracker {
  private lastGazePoint: GazePoint = { x: 0, y: 0 };
  private settings: TrackingSettings;

  constructor(settings: TrackingSettings) {
    this.settings = settings;
  }

  processEyeData(face: any): { gazePoint: GazePoint; isBlinking: boolean; confidence: number } {
    const landmarks = face.scaledMesh;
    
    // Calculate eye landmarks
    const rightEyeUpper = landmarks[159];
    const rightEyeLower = landmarks[145];
    const leftEyeUpper = landmarks[386];
    const leftEyeLower = landmarks[374];
    const rightIris = landmarks[473];
    const leftIris = landmarks[468];
    
    // Calculate face width for normalization
    const faceWidth = Math.sqrt(
      Math.pow(landmarks[454][0] - landmarks[234][0], 2) +
      Math.pow(landmarks[454][1] - landmarks[234][1], 2)
    );
    
    // Calculate eye openness
    const rightEyeHeight = Math.abs(rightEyeUpper[1] - rightEyeLower[1]) / faceWidth;
    const leftEyeHeight = Math.abs(leftEyeUpper[1] - leftEyeLower[1]) / faceWidth;
    const eyeOpenness = (rightEyeHeight + leftEyeHeight) / 2;
    
    // Blink detection
    const blinkThreshold = 0.012 - (0.0005 * (this.settings.sensitivity - 5));
    const isBlinking = eyeOpenness < blinkThreshold;
    
    // Calculate gaze point
    const irisX = (rightIris[0] + leftIris[0]) / 2;
    const irisY = (rightIris[1] + leftIris[1]) / 2;
    
    // Apply sensitivity and calibration
    const sensitivityFactor = Math.pow(this.settings.sensitivity / 5, 2.0);
    let calibratedX = (irisX - window.innerWidth / 2) * sensitivityFactor;
    let calibratedY = (irisY - window.innerHeight / 2) * sensitivityFactor;
    
    // Apply calibration if available
    if (this.settings.calibrationData) {
      // Apply calibration offsets
      calibratedX += this.settings.calibrationData.offsetX || 0;
      calibratedY += this.settings.calibrationData.offsetY || 0;
    }
    
    // Calculate screen coordinates
    const screenX = window.innerWidth * (0.5 + Math.pow(calibratedX / window.innerWidth, 7) * 0.009);
    const screenY = window.innerHeight * (0.5 + Math.pow(calibratedY / window.innerHeight, 7) * 0.009);
    
    // Apply smoothing
    const smoothedX = this.lastGazePoint.x * this.settings.smoothingFactor + 
                     screenX * (1 - this.settings.smoothingFactor);
    const smoothedY = this.lastGazePoint.y * this.settings.smoothingFactor + 
                     screenY * (1 - this.settings.smoothingFactor);
    
    // Constrain to screen bounds
    const gazePoint = {
      x: Math.max(10, Math.min(window.innerWidth - 10, smoothedX)),
      y: Math.max(10, Math.min(window.innerHeight - 10, smoothedY))
    };
    
    // Update last gaze point
    this.lastGazePoint = gazePoint;
    
    // Calculate confidence based on face visibility
    const confidence = Math.min(1, faceWidth / (window.innerWidth * 0.4));
    
    return {
      gazePoint,
      isBlinking,
      confidence
    };
  }
}

export default EyeTracker;

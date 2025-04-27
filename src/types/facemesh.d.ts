
// Type definitions for MediaPipe Facemesh
interface FacemeshModel {
  load(config: {
    maxFaces?: number;
    refineLandmarks?: boolean;
    detectionConfidence?: number;
    predictIrises?: boolean;
  }): Promise<{
    estimateFaces(options: {
      input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
      flipHorizontal?: boolean;
      predictIrises?: boolean;
    }): Promise<Array<{
      scaledMesh: number[][];
      boundingBox: {
        topLeft: number[];
        bottomRight: number[];
      };
    }>>;
  }>;
}

// Extend the Window interface
declare global {
  interface Window {
    facemesh: FacemeshModel;
    mouseX?: number;
    mouseY?: number;
    mouseListenerAdded?: boolean;
  }
}

export {};

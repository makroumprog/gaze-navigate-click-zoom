
export interface CameraState {
  isInitialized: boolean;
  stream: MediaStream | null;
  permissionDenied: boolean;
}

export class CameraManager {
  private state: CameraState = {
    isInitialized: false,
    stream: null,
    permissionDenied: false
  };

  private video: HTMLVideoElement;
  private onStateChange: (state: CameraState) => void;

  constructor(video: HTMLVideoElement, onStateChange: (state: CameraState) => void) {
    this.video = video;
    this.onStateChange = onStateChange;
  }

  async initialize(force: boolean = false): Promise<boolean> {
    if (this.state.isInitialized && !force) {
      return true;
    }

    try {
      if (this.state.stream) {
        this.state.stream.getTracks().forEach(track => {
          try { track.stop(); } catch (e) {}
        });
        this.state.stream = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: { ideal: 640, min: 320 },
          height: { ideal: 480, min: 240 }, 
          facingMode: "user",
          frameRate: { ideal: 30, min: 20 }  
        },
        audio: false
      });

      this.state.stream = stream;
      this.video.srcObject = stream;
      
      await this.ensureVideoPlaying();
      
      this.state.isInitialized = true;
      this.state.permissionDenied = false;
      this.onStateChange(this.state);
      
      return true;
    } catch (error) {
      console.error('Camera initialization error:', error);
      this.state.isInitialized = false;
      this.state.permissionDenied = error.name === 'NotAllowedError' || 
                                   error.name === 'PermissionDeniedError' || 
                                   error.message.includes('Permission');
      this.onStateChange(this.state);
      return false;
    }
  }

  private async ensureVideoPlaying(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video play timeout')), 5000);
      
      const tryPlay = (attempts = 0) => {
        this.video.play()
          .then(() => {
            clearTimeout(timeout);
            resolve();
          })
          .catch(e => {
            if (attempts < 7) {
              setTimeout(() => tryPlay(attempts + 1), 300);
            } else {
              clearTimeout(timeout);
              reject(e);
            }
          });
      };

      this.video.onloadedmetadata = () => {
        tryPlay();
      };
    });
  }

  cleanup() {
    if (this.state.stream) {
      this.state.stream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      this.state.stream = null;
    }
    this.state.isInitialized = false;
    this.onStateChange(this.state);
  }
}

export default CameraManager;

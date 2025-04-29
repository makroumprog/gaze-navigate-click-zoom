
// UI Components for GazeTech

interface UIElements {
  cursor: HTMLDivElement | null;
  video: HTMLVideoElement | null;
  canvas: HTMLCanvasElement | null;
  debugIndicator: HTMLDivElement | null;
  statusIndicator: HTMLDivElement | null;
}

export const createCursor = (): HTMLDivElement => {
  const cursor = document.createElement('div');
  cursor.id = 'gazetech-cursor';
  cursor.style.cssText = `
    position: fixed;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background-color: rgba(44, 123, 229, 0.7);
    border: 3px solid rgba(44, 123, 229, 0.9);
    pointer-events: none;
    z-index: 999999;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 15px rgba(44, 123, 229, 0.7);
    transition: transform 0.01s ease-out, background-color 0.2s;
  `;
  return cursor;
};

export const createVideo = (): HTMLVideoElement => {
  const video = document.createElement('video');
  video.id = 'gazetech-video';
  video.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    z-index: -1;
  `;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.setAttribute('playsinline', '');
  return video;
};

export const createCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.id = 'gazetech-canvas';
  canvas.width = 640;
  canvas.height = 480;
  canvas.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    z-index: -1;
  `;
  return canvas;
};

export const createDebugIndicator = (): HTMLDivElement => {
  const debugIndicator = document.createElement('div');
  debugIndicator.id = 'gazetech-debug';
  debugIndicator.style.cssText = `
    position: fixed;
    bottom: 10px;
    right: 10px;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 14px;
    font-family: Arial, sans-serif;
    z-index: 999999;
    transition: opacity 0.3s ease;
  `;
  return debugIndicator;
};

export const createStatusIndicator = (): HTMLDivElement => {
  const statusIndicator = document.createElement('div');
  statusIndicator.id = 'gazetech-status';
  statusIndicator.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background-color: red;
    z-index: 999999;
    box-shadow: 0 0 5px rgba(0, 0, 0, 0.5);
  `;
  return statusIndicator;
};

export class GazeTechUI {
  private elements: UIElements = {
    cursor: null,
    video: null,
    canvas: null,
    debugIndicator: null,
    statusIndicator: null
  };

  constructor(private isDebugMode: boolean = false) {}

  initialize() {
    this.elements.cursor = createCursor();
    this.elements.video = createVideo();
    this.elements.canvas = createCanvas();
    this.elements.debugIndicator = createDebugIndicator();
    this.elements.statusIndicator = createStatusIndicator();

    document.body.appendChild(this.elements.cursor);
    document.body.appendChild(this.elements.video);
    document.body.appendChild(this.elements.canvas);
    document.body.appendChild(this.elements.debugIndicator);
    document.body.appendChild(this.elements.statusIndicator);

    // Make sure the cursor is visible by default
    this.showCursor(true);
    
    this.updateDebugVisibility();
  }

  private updateDebugVisibility() {
    if (this.elements.debugIndicator) {
      this.elements.debugIndicator.style.display = this.isDebugMode ? 'block' : 'none';
    }
    if (this.elements.statusIndicator) {
      this.elements.statusIndicator.style.display = this.isDebugMode ? 'block' : 'none';
    }
  }

  getElements(): UIElements {
    return this.elements;
  }

  updateCursorPosition(x: number, y: number) {
    if (this.elements.cursor) {
      this.elements.cursor.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }

  // Enhanced showCursor method to properly handle cursor visibility
  showCursor(visible: boolean) {
    if (this.elements.cursor) {
      this.elements.cursor.style.opacity = visible ? '1' : '0';
      this.elements.cursor.style.display = visible ? 'block' : 'none';
      console.log('Cursor visibility set to:', visible);
    }
  }

  updateStatusIndicator(active: boolean) {
    if (this.elements.statusIndicator) {
      this.elements.statusIndicator.style.backgroundColor = active ? 'lime' : 'red';
      this.elements.statusIndicator.style.boxShadow = active 
        ? '0 0 10px rgba(0, 255, 0, 0.7)' 
        : '0 0 5px rgba(255, 0, 0, 0.7)';
    }
  }
}

export default GazeTechUI;

export class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.operations = [];
    this.fillStyle = '#000';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = true;
    this.transform = [1, 0, 0, 1, 0, 0];
    this.stack = [];
  }

  record(type, values = {}) {
    this.operations.push({
      type,
      ...values,
      fillStyle: this.fillStyle,
      alpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
    });
  }

  clearOperations() { this.operations.length = 0; }
  setTransform(...transform) { this.transform = transform; this.record('setTransform', { transform }); }
  translate(x, y) { this.record('translate', { x, y }); }
  rotate(angle) { this.record('rotate', { angle }); }
  save() {
    this.stack.push({
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
    });
    this.record('save');
  }
  restore() {
    const state = this.stack.pop();
    if (state) Object.assign(this, state);
    this.record('restore');
  }
  fillRect(x, y, width, height) { this.record('fillRect', { x, y, width, height }); }
  drawImage(source, ...args) { this.record('drawImage', { source: source?.__tag || source?.src || 'unknown', args }); }
  createImageData(width, height) {
    this.record('createImageData', { width, height });
    return { width, height, data: new Uint8ClampedArray(Math.max(0, width * height * 4)) };
  }
  putImageData(image, x, y) {
    let nonZero = 0;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i]) nonZero++;
    this.record('putImageData', { x, y, width: image.width, height: image.height, nonZero });
  }
}

export class FakeCanvas {
  constructor(tag, width = 0, height = 0) {
    this.__tag = tag;
    this._width = width;
    this._height = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this.style = {};
    this.context = new FakeCanvasContext(this);
  }

  get width() { return this._width; }
  set width(value) { this._width = value; this.context?.clearOperations(); }
  get height() { return this._height; }
  set height(value) { this._height = value; this.context?.clearOperations(); }
  getContext(type) { return type === '2d' ? this.context : null; }
  // Enough of the real API for the avatar: the game only ever embeds the
  // result in a CSS url(), so the tag is all a test needs to identify it.
  toDataURL() { return `data:image/png;base64,${this.__tag}`; }
}

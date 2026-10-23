'use strict';

// Camera zoom changes the recorded stream, never just the preview's CSS scale.
class CamSyncZoom {
  constructor({ video, canvas, control, button, onError }) {
    Object.assign(this, { video, canvas, control, button, onError });
    this.points = new Map();
    this.state = null;
    this.gesture = null;
    button.addEventListener('click', () => this.set(1));
    video.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || this.points.size >= 2) return;
      this.points.set(event.pointerId, [event.clientX, event.clientY]);
      try { video.setPointerCapture(event.pointerId); } catch {}
      if (this.points.size === 2) {
        event.preventDefault();
        const distance = this.distance();
        this.gesture = distance > 0 && this.state ? { distance, zoom: this.state.desired } : null;
        if (!this.state?.supported) onError('Camera zoom isn’t available in this browser.');
      }
    });
    video.addEventListener('pointermove', (event) => {
      if (!this.points.has(event.pointerId)) return;
      this.points.set(event.pointerId, [event.clientX, event.clientY]);
      if (this.points.size === 2 && this.gesture) {
        event.preventDefault();
        this.set(this.gesture.zoom * this.distance() / this.gesture.distance);
      }
    });
    const release = (event) => { this.points.delete(event.pointerId); this.gesture = null; };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) video.addEventListener(name, release);
    // Safari may also emit gesture events. Keep the page at its normal scale.
    for (const name of ['gesturestart', 'gesturechange']) video.addEventListener(name, (event) => event.preventDefault(), { passive: false });
  }

  distance() {
    const [a, b] = this.points.values();
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  }

  start(stream) {
    this.stop();
    const track = stream.getVideoTracks()[0];
    let range;
    try { range = track.getCapabilities?.().zoom; } catch {}
    const native = range && Number.isFinite(range.min) && range.min > 0 && Number.isFinite(range.max) && range.max > range.min;
    const state = this.state = { track, stream, mode: native ? 'camera' : 'digital', zoom: 1, desired: 1,
      min: native ? range.min : 1, max: native ? range.max : 4, step: native && range.step > 0 ? range.step : 0.01,
      supported: !!native, applying: false };
    if (native) {
      state.zoom = state.desired = Math.min(state.max, Math.max(state.min, track.getSettings().zoom || 1));
    } else {
      // A canvas crop is used for both the preview and the encoder, including at
      // 1×, so pinching during recording never replaces its video/audio tracks.
      const { width, height } = track.getSettings();
      // Use the decoded orientation; iOS may rotate the pixels relative to track settings.
      this.canvas.width = this.video.videoWidth || width;
      this.canvas.height = this.video.videoHeight || height;
      try {
        if (!this.canvas.captureStream) throw new Error('Canvas capture unavailable');
        state.context = this.canvas.getContext('2d', { alpha: false });
        if (!state.context) throw new Error('Canvas unavailable');
        this.draw(state);
        state.output = this.canvas.captureStream(30);
        if (!state.output.getVideoTracks().length) throw new Error('Canvas capture unavailable');
        state.recording = new MediaStream([...state.output.getVideoTracks(), ...stream.getAudioTracks()]);
        state.supported = true;
        this.canvas.classList.remove('hidden');
        this.canvas.classList.toggle('mirror', this.video.classList.contains('mirror'));
        this.paint(state);
      } catch {
        state.output?.getVideoTracks().forEach((t) => t.stop());
        state.output = null;
        state.recording = null;
      }
    }
    this.render();
  }

  get recordingStream() { return this.state?.recording || this.state?.stream; }

  set(value) {
    const state = this.state;
    if (!state?.supported || !Number.isFinite(value)) return;
    const clamped = Math.min(state.max, Math.max(state.min, value));
    state.desired = Math.min(state.max, Math.max(state.min, state.min + Math.round((clamped - state.min) / state.step) * state.step));
    if (state.mode === 'digital') {
      state.zoom = state.desired;
      this.draw(state);
      this.render();
    } else if (!state.applying) this.apply(state);
  }

  async apply(state) {
    state.applying = true;
    try {
      while (this.state === state && Math.abs(state.desired - state.zoom) > 0.0001) {
        const value = state.desired;
        const constraints = state.track.getConstraints?.() || {};
        try {
          await state.track.applyConstraints({ ...constraints,
            advanced: [...(constraints.advanced || []).filter((c) => !('zoom' in c)), { zoom: value }] });
          if (this.state !== state) return;
          const actual = state.track.getSettings().zoom;
          state.zoom = Number.isFinite(actual) ? actual : value;
          // Some cameras round to a supported step. Do not retry forever.
          if (state.desired === value) state.desired = state.zoom;
          this.render();
        } catch {
          if (this.state !== state) return;
          state.desired = state.zoom;
          this.onError('Couldn’t change camera zoom. Try pinching again.');
          return;
        }
      }
    } finally { state.applying = false; }
  }

  draw(state) {
    if (this.state !== state || this.video.readyState < 2) return;
    const width = this.video.videoWidth, height = this.video.videoHeight;
    if (!width || !height) return;
    const croppedWidth = width / state.zoom, croppedHeight = height / state.zoom;
    state.context.drawImage(this.video, (width - croppedWidth) / 2, (height - croppedHeight) / 2,
      croppedWidth, croppedHeight, 0, 0, this.canvas.width, this.canvas.height);
  }

  paint(state) {
    if (this.state !== state) return;
    this.draw(state);
    // Match decoded camera frames where available; captureStream caps output at 30 fps.
    if (this.video.requestVideoFrameCallback) state.frame = this.video.requestVideoFrameCallback(() => this.paint(state));
    else state.animation = requestAnimationFrame(() => this.paint(state));
  }

  render() {
    const state = this.state;
    this.control.classList.toggle('hidden', !state?.supported);
    if (!state) return;
    const value = Number(state.zoom.toFixed(2));
    this.button.textContent = `${value}×`;
    this.button.setAttribute('aria-label', `Camera zoom ${value} times. Reset zoom`);
  }

  stop() {
    const state = this.state;
    this.state = null;
    this.points.clear();
    this.gesture = null;
    if (state?.frame !== undefined) this.video.cancelVideoFrameCallback?.(state.frame);
    if (state?.animation !== undefined) cancelAnimationFrame(state.animation);
    state?.output?.getVideoTracks().forEach((t) => t.stop());
    this.canvas.classList.add('hidden');
    this.control.classList.add('hidden');
  }
}

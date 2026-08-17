function parameter(log, name) {
  return {
    value: 1,
    setValueAtTime(value, time) { this.value = value; log.push({ type: 'set', name, value, time }); },
    linearRampToValueAtTime(value, time) { this.value = value; log.push({ type: 'linear', name, value, time }); },
    exponentialRampToValueAtTime(value, time) { this.value = value; log.push({ type: 'exponential', name, value, time }); },
  };
}

class AudioNode {
  constructor(log, type) { this.log = log; this.type = type; }
  connect(target) { this.log.push({ type: 'connect', from: this.type, to: target?.type || 'destination' }); return target || this; }
}

export function createAudioEnvironment(clock, { rejectResume = false, constructorThrows = false } = {}) {
  const log = [];
  const contexts = [];

  class FakeAudioContext {
    constructor() {
      if (constructorThrows) throw new Error('AudioContext unavailable');
      this.type = 'context';
      this.state = 'suspended';
      this.destination = { type: 'destination' };
      contexts.push(this);
      log.push({ type: 'context' });
    }
    get currentTime() { return clock.now / 1000; }
    createGain() {
      const node = new AudioNode(log, 'gain');
      node.gain = parameter(log, 'gain');
      return node;
    }
    createBufferSource() {
      const node = new AudioNode(log, 'bufferSource');
      node.start = time => log.push({ type: 'start', node: 'bufferSource', time });
      return node;
    }
    createOscillator() {
      const node = new AudioNode(log, 'oscillator');
      node.frequency = parameter(log, 'frequency');
      node.start = time => log.push({ type: 'start', node: 'oscillator', time });
      node.stop = time => log.push({ type: 'stop', node: 'oscillator', time });
      node.type = 'sine';
      return node;
    }
    createBuffer(channels, length, rate) { return { channels, length, rate }; }
    resume() {
      log.push({ type: 'resume' });
      if (!rejectResume) this.state = 'running';
      return { catch(callback) { if (rejectResume) callback(new Error('Audio resume rejected')); } };
    }
  }

  return { AudioContext: FakeAudioContext, log, contexts };
}

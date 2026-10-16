// AudioWorklet for the TUI voice agent (voice.js), a copy of public/pcm-capture.js:
// the TUI is also mounted at /tui/, where the UI's copy is out of reach. Batches
// the mic's render quanta (Float32 at the context's 16 kHz) into 100 ms chunks
// and posts each to the main thread. A static file so the CSP stays script-src 'self'.
const CHUNK = 1600

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(CHUNK)
    this.n = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    let i = 0
    while (i < ch.length) {
      const take = Math.min(ch.length - i, CHUNK - this.n)
      this.buf.set(ch.subarray(i, i + take), this.n)
      this.n += take
      i += take
      if (this.n === CHUNK) {
        this.port.postMessage(this.buf.slice())
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor)

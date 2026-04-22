/**
 * AudioWorklet processor — runs on the audio thread, unaffected by
 * background-tab throttling that silences ScriptProcessorNode.
 */
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      // Send a copy; the original buffer is reused by the engine
      this.port.postMessage(ch.slice());
    }
    return true; // keep alive
  }
}

registerProcessor("audio-processor", AudioProcessor);

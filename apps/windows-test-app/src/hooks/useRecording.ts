import { useState, useRef, useCallback, useEffect } from "react";
import { encodeWav } from "../lib/wavEncode";

export interface UseRecordingReturn {
  isRecording: boolean;
  durationSec: number;
  recordingBlob: Blob | null;
  activeMicLabel: string;
  analyserRef: React.MutableRefObject<AnalyserNode | null>;
  startRecording: (deviceId?: string) => Promise<void>;
  stopRecording: () => void;
  clearRecording: () => void;
  error: string | null;
}

const BUFFER_SIZE = 4096;

export function useRecording(): UseRecordingReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [activeMicLabel, setActiveLabel] = useState("");

  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const keepAliveRef = useRef<OscillatorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    keepAliveRef.current?.stop();
    keepAliveRef.current?.disconnect();
    audioCtxRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    processorRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    keepAliveRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const startRecording = useCallback(async (deviceId?: string) => {
    setError(null);
    setRecordingBlob(null);
    samplesRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streamRef.current = stream;

      // Log the actual device being used so we can verify it's the right mic
      const track = stream.getAudioTracks()[0];
      console.info("[mic]", track?.label, track?.getSettings());
      setActiveLabel(track?.label ?? "unknown");

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      // ── Keep the AudioContext alive when the window is not focused ──────────
      // Chromium auto-suspends AudioContexts in background "tabs". Connecting a
      // silent oscillator tricks the engine into treating this context as active
      // (it has an ongoing source), preventing suspension and ensuring
      // onaudioprocess keeps firing even when another window has focus.
      const keepAlive = ctx.createOscillator();
      const keepAliveGain = ctx.createGain();
      keepAliveGain.gain.value = 0; // truly silent — no speaker output
      keepAlive.connect(keepAliveGain);
      keepAliveGain.connect(ctx.destination);
      keepAlive.start();
      keepAliveRef.current = keepAlive;

      // Also auto-resume if the context gets suspended despite the above
      ctx.onstatechange = () => {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
      };
      await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;             // 128 bins — enough for 9 distinct bands
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);           // tap only, doesn't affect signal chain
      analyserRef.current = analyser;

      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        samplesRef.current.push(new Float32Array(data));
      };

      // Mic → processor → muted gain → destination
      // (destination connection keeps onaudioprocess firing)
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);

      setIsRecording(true);
      startTimeRef.current = Date.now();
      setDurationSec(0);
      timerRef.current = setInterval(() => {
        setDurationSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 500);
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : "Microphone access denied");
    }
  }, [cleanup]);

  const stopRecording = useCallback(() => {
    const allSamples = samplesRef.current;
    const sampleRate = audioCtxRef.current?.sampleRate ?? 44100;
    cleanup();
    setIsRecording(false);

    if (allSamples.length === 0) return;

    const totalLen = allSamples.reduce((n, s) => n + s.length, 0);
    const pcm = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of allSamples) { pcm.set(chunk, offset); offset += chunk.length; }

    setRecordingBlob(encodeWav(pcm, sampleRate));
  }, [cleanup]);

  const clearRecording = useCallback(() => {
    setRecordingBlob(null);
    setDurationSec(0);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  return { isRecording, durationSec, recordingBlob, activeMicLabel, analyserRef, startRecording, stopRecording, clearRecording, error };
}

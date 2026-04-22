import { useEffect, useRef } from "react";
import type { AppState } from "../App";

interface Props { appState: AppState; }

export function SignatureLine({ appState }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentRef = useRef("#a78bfa");
  const opacityRef = useRef(0.1);

  useEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      if (v) accentRef.current = v;
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-accent", "data-theme"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf: number;
    let last = performance.now();
    let phase = 0;
    let amp = 0;
    let ampTarget = 0;
    let pausePhase = Math.random() * 2;

    const targetOpacity: Record<AppState, number> = { idle: 0.25, recording: 0.95, processing: 0.7, done: 0, error: 0.1 };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      phase += dt;
      pausePhase += dt * 0.45;

      if (appState === "recording") {
        const breath = 0.5 + 0.5 * Math.sin(pausePhase * 1.2);
        const syllable = (Math.sin(now * 0.012) * 0.5 + 0.5) * (Math.sin(now * 0.037) * 0.5 + 0.5);
        ampTarget = breath * syllable * (0.35 + Math.random() * 0.65);
        if (Math.sin(pausePhase * 0.4) < -0.5) ampTarget *= 0.15;
      } else if (appState === "processing") {
        ampTarget = 0.25 + 0.12 * Math.sin(phase * 1.4);
      } else if (appState === "idle") {
        ampTarget = 0.04 + 0.03 * Math.sin(phase * 0.8);
      } else {
        ampTarget = 0;
      }
      amp += (ampTarget - amp) * Math.min(1, dt * 9);
      opacityRef.current += ((targetOpacity[appState] ?? 0.1) - opacityRef.current) * Math.min(1, dt * 4);

      const rect = canvas.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      ctx.clearRect(0, 0, W, H);
      if (opacityRef.current < 0.01) { raf = requestAnimationFrame(draw); return; }

      const accent = accentRef.current;
      const midY = H / 2;
      const baseGrad = ctx.createLinearGradient(0, 0, W, 0);
      baseGrad.addColorStop(0, "transparent");
      baseGrad.addColorStop(0.5, accent);
      baseGrad.addColorStop(1, "transparent");

      if (appState === "processing") {
        const shimmerX = ((phase * 0.35) % 1.4) - 0.2;
        const shimmerGrad = ctx.createLinearGradient(shimmerX * W - W * 0.35, 0, shimmerX * W + W * 0.35, 0);
        shimmerGrad.addColorStop(0, "transparent");
        shimmerGrad.addColorStop(0.5, accent);
        shimmerGrad.addColorStop(1, "transparent");
        ctx.globalAlpha = opacityRef.current * 0.35;
        ctx.fillStyle = baseGrad;
        ctx.fillRect(0, midY - 0.5, W, 1);
        ctx.globalAlpha = opacityRef.current;
        ctx.fillStyle = shimmerGrad;
        ctx.fillRect(0, midY - 1, W, 2);
        ctx.globalAlpha = opacityRef.current * 0.15;
        ctx.fillStyle = shimmerGrad;
        ctx.fillRect(0, midY - 6, W, 12);
      } else {
        for (let pass = 0; pass < 3; pass++) {
          ctx.globalAlpha = opacityRef.current * [0.10, 0.28, 1.0][pass];
          ctx.lineWidth = [8, 3, 1][pass];
          ctx.strokeStyle = baseGrad;
          ctx.lineCap = "round";
          ctx.beginPath();
          const segments = Math.max(80, Math.floor(W / 3));
          const maxAmp = H * 0.38;
          for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const x = t * W;
            const env = Math.sin(t * Math.PI);
            const wave = Math.sin(t * 12 + phase * 2.0) * 0.55 + Math.sin(t * 27 + phase * 3.3) * 0.30 + Math.sin(t * 6 + phase * 1.1) * 0.15;
            const y = midY + wave * maxAmp * amp * env;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [appState]);

  return (
    <div className={`sigline sigline-${appState}`} aria-hidden>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

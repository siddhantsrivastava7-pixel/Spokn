import { useEffect, useRef } from "react";

export type WaveformVariant = "ripple" | "bars" | "pulse" | "line";

interface Props {
  active: boolean;
  variant?: WaveformVariant;
}

export function Waveform({ active, variant = "ripple" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accentRef = useRef("#a78bfa");

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
    let valSmooth = 0;
    let valTarget = 0;
    let pausePhase = Math.random() * 2;
    const history: number[] = [];

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

      if (active) {
        const breath = 0.5 + 0.5 * Math.sin(pausePhase * 1.2);
        const syllable = (Math.sin(now * 0.012) * 0.5 + 0.5) * (Math.sin(now * 0.037) * 0.5 + 0.5);
        const noise = 0.35 + Math.random() * 0.65;
        valTarget = breath * syllable * noise;
        if (Math.sin(pausePhase * 0.4) < -0.5) valTarget *= 0.1;
      } else {
        valTarget = 0;
      }
      valSmooth += (valTarget - valSmooth) * Math.min(1, dt * 9);

      const rect = canvas.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      ctx.clearRect(0, 0, W, H);
      const accent = accentRef.current || "#a78bfa";

      if (variant === "ripple") drawRipple(ctx, W, H, valSmooth, phase, accent);
      else if (variant === "bars") {
        history.push(valSmooth);
        if (history.length > 64) history.shift();
        drawBars(ctx, W, H, history, accent);
      } else if (variant === "pulse") drawPulse(ctx, W, H, valSmooth, phase, accent);
      else drawLine(ctx, W, H, valSmooth, phase, accent);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [active, variant]);

  return (
    <div className="wave-wrap">
      <canvas ref={canvasRef} className="wave-canvas" />
    </div>
  );
}

function drawRipple(ctx: CanvasRenderingContext2D, W: number, H: number, amp: number, phase: number, accent: string) {
  const midY = H / 2;
  const segments = Math.max(60, Math.floor(W / 4));
  const maxAmp = H * 0.35;
  const glow = ctx.createLinearGradient(0, 0, W, 0);
  glow.addColorStop(0, "transparent");
  glow.addColorStop(0.5, accent);
  glow.addColorStop(1, "transparent");

  for (let pass = 0; pass < 3; pass++) {
    ctx.beginPath();
    ctx.globalAlpha = [0.06 + amp * 0.1, 0.18 + amp * 0.25, 0.8 + amp * 0.2][pass];
    ctx.lineWidth = [6, 2.5, 1][pass];
    ctx.strokeStyle = glow;
    ctx.lineCap = "round";
    for (let i = 0; i <= segments; i++) {
      const x = (i / segments) * W;
      const t = i / segments;
      const env = Math.sin(t * Math.PI);
      const wave = Math.sin(t * 14 + phase * 2.3) * 0.5 + Math.sin(t * 33 + phase * 4.1) * 0.3 + Math.sin(t * 7 + phase * 1.2) * 0.2;
      const y = midY + wave * maxAmp * amp * env;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  if (amp < 0.02) {
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.strokeStyle = glow;
    ctx.beginPath();
    ctx.moveTo(W * 0.15, midY);
    ctx.lineTo(W * 0.85, midY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawBars(ctx: CanvasRenderingContext2D, W: number, H: number, history: number[], accent: string) {
  const n = history.length;
  const barW = W / 90;
  const gap = barW * 0.5;
  const maxH = H * 0.7;
  const startX = W / 2 - (n * (barW + gap)) / 2;
  for (let i = 0; i < n; i++) {
    const v = history[i]!;
    const h = Math.max(2, v * maxH);
    const x = startX + i * (barW + gap);
    const y = H / 2 - h / 2;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.4 + (i / n) * 0.6;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, h, barW / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPulse(ctx: CanvasRenderingContext2D, W: number, H: number, amp: number, phase: number, accent: string) {
  const cx = W / 2, cy = H / 2;
  for (let r = 0; r < 4; r++) {
    const t = (phase * 0.8 + r * 0.25) % 1;
    const radius = 10 + t * 80 + amp * 40;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = (1 - t) * (0.4 + amp * 0.4);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, 6 + amp * 8, 0, Math.PI * 2);
  ctx.fill();
}

function drawLine(ctx: CanvasRenderingContext2D, W: number, H: number, amp: number, phase: number, accent: string) {
  const mid = H / 2;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const t = x / W;
    const env = Math.sin(t * Math.PI);
    const y = mid + Math.sin(t * 20 + phase * 3) * amp * H * 0.3 * env;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

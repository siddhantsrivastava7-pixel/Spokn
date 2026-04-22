import { ICpu } from "./Icons";
import type {
  ConfidenceTier,
  IntentDetection,
  TranscribeResult,
  TransformationLevel,
} from "../lib/types";
import type { Mode } from "./LeftPanel";

interface Props {
  open: boolean;
  result: TranscribeResult | null;
  mode: Mode;
  langs: string[];
}

function intentLabel(intent: IntentDetection["intent"]): string {
  switch (intent) {
    case "bullet_list": return "Bullet list";
    case "numbered_list": return "Numbered list";
    case "todo_list": return "To-do list";
    case "email": return "Email";
    case "message": return "Message";
    case "meeting_notes": return "Meeting notes";
    default: return "Paragraph";
  }
}

function tierClass(tier: ConfidenceTier | undefined): string {
  if (tier === "HIGH") return "ok";
  if (tier === "LOW") return "danger";
  return "";
}

function transformationLabel(level: TransformationLevel | undefined): string {
  if (!level) return "—";
  if (level === "low") return "low — casing/punct only";
  if (level === "medium") return "medium — formatting applied";
  return "high — templates applied";
}

export function DebugPanel({ open, result, mode, langs }: Props) {
  const routing = result?.routing;
  const transcript = result?.transcript;
  const intent = transcript?.detectedIntent;

  const reprocessedCount =
    transcript?.segments.filter((s) => s.reprocessed).length ?? 0;

  const latencyBreakdown = transcript?.latencyBreakdown ?? {};
  const latencyKeys = Object.keys(latencyBreakdown);

  return (
    <aside className={`debug ${open ? "" : "collapsed"}`} aria-hidden={!open}>
      <div className="debug-inner">
        <div className="debug-header">
          <div className="debug-title">
            <ICpu size={13} /> Why this output?
            <span className="pill">live</span>
          </div>
        </div>
        <div className="debug-body">
          <div className="dbg-group">
            <div className="dbg-label">Output</div>
            <div className="dbg-kv">
              <span className="dbg-k">intent</span>
              <span className={`dbg-v ${intent && intent.intent !== "paragraph" ? "accent" : ""}`}>
                {intent ? intentLabel(intent.intent) : "—"}
                {intent && intent.confidence > 0 && (
                  <span style={{ color: "var(--text-4)", fontSize: 10, marginLeft: 6 }}>
                    {(intent.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </span>
            </div>
            <div className="dbg-kv">
              <span className="dbg-k">quality.tier</span>
              <span className={`dbg-v ${tierClass(transcript?.qualityTier)}`}>
                {transcript?.qualityTier ?? "—"}
              </span>
            </div>
            <div className="dbg-kv">
              <span className="dbg-k">transform.level</span>
              <span className="dbg-v">{transformationLabel(transcript?.transformationLevel)}</span>
            </div>
            <div className="dbg-kv">
              <span className="dbg-k">processing.mode</span>
              <span className="dbg-v">{transcript?.processingMode ?? "—"}</span>
            </div>
            {transcript?.fallbackUsed && (
              <div className="dbg-kv">
                <span className="dbg-k">fallback</span>
                <span className="dbg-v" style={{ color: "var(--danger)" }}>
                  {transcript.fallbackStage ?? "yes"}
                </span>
              </div>
            )}
          </div>

          {(transcript?.audioQuality || transcript?.preprocessing) && (
            <div className="dbg-group">
              <div className="dbg-label">Audio quality</div>
              {transcript?.preprocessing && (
                <div className="dbg-kv">
                  <span className="dbg-k">preprocess</span>
                  <span className={`dbg-v ${transcript.preprocessing.applied ? "accent" : ""}`}>
                    {transcript.preprocessing.applied ? "applied" : "skipped"}
                    <span style={{ color: "var(--text-4)", fontSize: 10, marginLeft: 6 }}>
                      {transcript.preprocessing.reason}
                    </span>
                  </span>
                </div>
              )}
              {transcript?.preprocessing?.stages && transcript.preprocessing.stages.length > 0 && (
                <div className="dbg-kv">
                  <span className="dbg-k">stages</span>
                  <span className="dbg-v">{transcript.preprocessing.stages.join(" → ")}</span>
                </div>
              )}
              {transcript?.audioQuality && (
                <>
                  <div className="dbg-kv">
                    <span className="dbg-k">rms</span>
                    <span className="dbg-v">{transcript.audioQuality.rmsDb.toFixed(1)} dB</span>
                  </div>
                  <div className="dbg-kv">
                    <span className="dbg-k">peak</span>
                    <span className="dbg-v">{transcript.audioQuality.peakDb.toFixed(1)} dB</span>
                  </div>
                  {transcript.audioQuality.clippingRatio > 0 && (
                    <div className="dbg-kv">
                      <span className="dbg-k">clipping</span>
                      <span className="dbg-v">{(transcript.audioQuality.clippingRatio * 100).toFixed(2)}%</span>
                    </div>
                  )}
                  {transcript.audioQuality.silenceRatio > 0 && (
                    <div className="dbg-kv">
                      <span className="dbg-k">silence</span>
                      <span className="dbg-v">{(transcript.audioQuality.silenceRatio * 100).toFixed(0)}%</span>
                    </div>
                  )}
                  {transcript.audioQuality.reasons.length > 0 && (
                    <div className="dbg-kv">
                      <span className="dbg-k">flags</span>
                      <span className="dbg-v" style={{ color: "var(--warn, #a06)" }}>
                        {transcript.audioQuality.reasons.join(", ")}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {intent && intent.signals && (intent.signals.triggers.length > 0 || intent.signals.structural.length > 0) && (
            <div className="dbg-group">
              <div className="dbg-label">Intent signals</div>
              {intent.signals.triggers.length > 0 && (
                <div className="dbg-kv">
                  <span className="dbg-k">triggers</span>
                  <span className="dbg-v">{intent.signals.triggers.join(", ")}</span>
                </div>
              )}
              {intent.signals.structural.length > 0 && (
                <div className="dbg-kv">
                  <span className="dbg-k">structural</span>
                  <span className="dbg-v">{intent.signals.structural.join(", ")}</span>
                </div>
              )}
              {intent.signals.lengthPattern && (
                <div className="dbg-kv">
                  <span className="dbg-k">length</span>
                  <span className="dbg-v">{intent.signals.lengthPattern}</span>
                </div>
              )}
              {intent.carriedFromSession && (
                <div className="dbg-kv">
                  <span className="dbg-k">session</span>
                  <span className="dbg-v">carried from prior input</span>
                </div>
              )}
            </div>
          )}

          {transcript && (reprocessedCount > 0 || (transcript.downgrades?.length ?? 0) > 0) && (
            <div className="dbg-group">
              <div className="dbg-label">Pipeline</div>
              {reprocessedCount > 0 && (
                <div className="dbg-kv">
                  <span className="dbg-k">reprocessed</span>
                  <span className="dbg-v accent">{reprocessedCount} segment{reprocessedCount === 1 ? "" : "s"}</span>
                </div>
              )}
              {(transcript.downgrades ?? []).map((d, i) => (
                <div className="dbg-kv" key={i}>
                  <span className="dbg-k">downgrade</span>
                  <span className="dbg-v" style={{ color: "var(--warn, #a06)" }}>{d}</span>
                </div>
              ))}
            </div>
          )}

          {latencyKeys.length > 0 && (
            <div className="dbg-group">
              <div className="dbg-label">Latency</div>
              <div className="dbg-kv">
                <span className="dbg-k">total</span>
                <span className="dbg-v accent">{transcript?.latencyMs ?? result?.processingTimeMs}ms</span>
              </div>
              {latencyKeys.map((k) => (
                <div className="dbg-kv" key={k}>
                  <span className="dbg-k">{k}</span>
                  <span className="dbg-v">{latencyBreakdown[k]}ms</span>
                </div>
              ))}
            </div>
          )}

          <div className="dbg-group">
            <div className="dbg-label">Routing</div>
            <div className="dbg-kv"><span className="dbg-k">input.mode</span><span className="dbg-v">{mode.toLowerCase()}</span></div>
            <div className="dbg-kv"><span className="dbg-k">input.lang</span><span className="dbg-v">{langs.join(", ")}</span></div>
            <div className="dbg-kv"><span className="dbg-k">resolved.mode</span><span className="dbg-v accent">{routing?.resolvedMode.mode ?? "—"}</span></div>
            <div className="dbg-kv"><span className="dbg-k">resolved.model</span><span className="dbg-v accent">{routing?.selectedModel.id ?? "—"}</span></div>
            <div className="dbg-kv"><span className="dbg-k">model.size</span><span className="dbg-v">{routing ? `${routing.selectedModel.sizeMB} MB` : "—"}</span></div>
            <div className="dbg-kv"><span className="dbg-k">status</span><span className={`dbg-v ${result ? "ok" : ""}`}>{result ? "OK" : "idle"}</span></div>
          </div>

          {routing && routing.selectionReasons.length > 0 && (
            <div className="dbg-group">
              <div className="dbg-label">Routing reasons</div>
              <div className="dbg-list">
                {routing.selectionReasons.map((r, i) => (
                  <div className="dbg-reason" key={i}>
                    <span className="dbg-reason-bar" />
                    <span className="dbg-reason-text">
                      <span className="n">{String(i + 1).padStart(2, "0")} </span>{r}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {routing && routing.appliedBiases.length > 0 && (
            <div className="dbg-group">
              <div className="dbg-label">Applied biases</div>
              {routing.appliedBiases.map((b, i) => (
                <div className="dbg-bias" key={i}>
                  <span className="dbg-bias-k">{b}</span>
                  <span className="dbg-bias-bar"><div style={{ width: "60%" }} /></span>
                </div>
              ))}
            </div>
          )}

          {routing && routing.fallbackCandidates.length > 0 && (
            <div className="dbg-group">
              <div className="dbg-label">Fallback candidates</div>
              {routing.fallbackCandidates.map((c) => (
                <div className="dbg-fallback" key={c.id}>
                  <span className="dbg-fallback-name">{c.id}</span>
                  <span className="dbg-fallback-score">{c.sizeMB} MB</span>
                </div>
              ))}
            </div>
          )}

          {routing && routing.rejectedCandidates.length > 0 && (
            <div className="dbg-group">
              <div className="dbg-label">Rejected candidates</div>
              {routing.rejectedCandidates.map((c) => (
                <div className="dbg-fallback" key={c.modelId}>
                  <span className="dbg-fallback-name">{c.modelId}</span>
                  <span className="dbg-fallback-score" style={{ color: "var(--danger)", fontSize: 10 }}>{c.reason}</span>
                </div>
              ))}
            </div>
          )}

          {transcript && (
            <div className="dbg-group">
              <div className="dbg-label">Segments</div>
              <div className="dbg-kv"><span className="dbg-k">count</span><span className="dbg-v">{transcript.segments.length}</span></div>
              <div className="dbg-kv"><span className="dbg-k">language</span><span className="dbg-v">{transcript.language}</span></div>
              {transcript.segments.some((s) => s.tier) && (
                <div className="dbg-kv">
                  <span className="dbg-k">tiers</span>
                  <span className="dbg-v">
                    {(["HIGH", "MEDIUM", "LOW"] as ConfidenceTier[])
                      .map((tier) => {
                        const n = transcript.segments.filter((s) => s.tier === tier).length;
                        return n > 0 ? `${tier}:${n}` : null;
                      })
                      .filter(Boolean)
                      .join(" / ")}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

import { parsePath, provenanceOf } from '../lib/hypothesis'
import SampleDataNotice from './SampleDataNotice'

export default function HypothesisCard({ hypothesis, triggered, activeWindow, detectionWindow }) {
  if (!triggered || !hypothesis) return null

  const formatTimestamp = (ts) => ts.replace('T', ' ').replace('Z', '') + ' UTC'

  // One parser for every separator a model might emit, shared with the chat
  // panel so both cannot disagree about the same field.
  const nodes = parsePath(hypothesis.cascade_path)
  const provenance = provenanceOf(hypothesis)
  const multiService = nodes.length > 1

  return (
    <div style={{
      background: '#1a1d2e', borderRadius: '8px',
      border: '1px solid #2a2d3e', borderLeft: '4px solid #ef4444',
      padding: '24px', width: '100%', boxSizing: 'border-box'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: '#ffffff', fontWeight: 700, fontSize: '17px' }}>
            Drift summary
          </div>
          <div style={{ color: '#8b8fa8', fontSize: '12px', marginTop: '2px' }}>
            {provenance.detail}
          </div>
        </div>
        <div>
          <span style={{
            background: '#1a1d2e', border: '1px solid #2a2d3e',
            color: '#8b8fa8', fontSize: '11px',
            padding: '3px 10px', borderRadius: '12px'
          }}>
            {provenance.label}
          </span>
          <div style={{ color: '#4a4d5e', fontSize: '10px', marginTop: '4px', textAlign: 'right' }}>
            Detected: {formatTimestamp(detectionWindow.window_timestamp)}
          </div>
        </div>
      </div>

      {provenance.kind === 'sample' && (
        <div style={{ marginTop: '12px' }}>
          <SampleDataNotice>
            This explanation is fixed text from the bundled incident scenario. The detector below is
            running for real on that scenario's telemetry; this narrative is not its output.
          </SampleDataNotice>
        </div>
      )}

      {activeWindow > detectionWindow.window_number && (
        <div style={{ color: '#4a4d5e', fontSize: '11px', fontStyle: 'italic', marginTop: '8px' }}>
          Analysis anchored to W{detectionWindow.window_number} — the moment of detection
        </div>
      )}

      <div style={{ borderTop: '1px solid #2a2d3e', margin: '16px 0' }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
        <div>
          <div style={{ color: '#8b8fa8', fontSize: '11px', letterSpacing: '2px', fontWeight: 600 }}>
            {multiService ? 'ROOT SERVICE (SCENARIO)' : 'DRIFTING SERVICE'}
          </div>
          <span style={{
            background: '#2a1215', border: '1px solid #ef444444',
            color: '#ef4444', padding: '6px 14px', borderRadius: '6px',
            fontSize: '15px', fontWeight: 700, display: 'inline-block', marginTop: '8px'
          }}>
            {hypothesis.root_service}
          </span>
        </div>
        <div>
          <div style={{ color: '#8b8fa8', fontSize: '11px', letterSpacing: '2px', fontWeight: 600 }}>
            FAILURE MECHANISM
          </div>
          <div style={{ color: '#ffffff', fontSize: '14px', lineHeight: 1.6, marginTop: '8px' }}>
            {hypothesis.mechanism}
          </div>
        </div>
      </div>

      <div style={{ marginTop: '16px' }}>
        <div style={{ color: '#8b8fa8', fontSize: '11px', letterSpacing: '2px', fontWeight: 600 }}>
          {multiService ? 'SCENARIO PATH' : 'SCOPE'}
        </div>
        <div style={{ color: '#4a4d5e', fontSize: '11px', marginTop: '6px', lineHeight: 1.6 }}>
          {multiService
            ? 'Declared by the bundled scenario. Faultline evaluates each service independently and does not observe dependencies, traces, or request propagation, so it cannot establish this ordering.'
            : 'Faultline evaluates one service at a time. This summary covers drift within that service only.'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
          {nodes.map((node, i) => (
            <span key={`node-${i}`} style={{ display: 'contents' }}>
              <span style={{
                background: '#1a1d2e',
                border: `1px solid ${i === 0 ? '#ef4444' : '#ef444444'}`,
                color: '#ffffff', padding: '6px 14px', borderRadius: '20px',
                fontSize: '13px', fontWeight: 600
              }}>
                {node}
              </span>
              {i < nodes.length - 1 && (
                <span style={{ color: '#ef4444', fontSize: '18px', fontWeight: 700 }}>→</span>
              )}
            </span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: '16px' }}>
        <div style={{ color: '#8b8fa8', fontSize: '11px', letterSpacing: '2px', fontWeight: 600 }}>
          EVIDENCE
        </div>
        {hypothesis.evidence.map((item, index) => (
          <div key={`evidence-${index}`} style={{
            display: 'flex', alignItems: 'flex-start', gap: '12px',
            marginTop: '10px', padding: '10px 14px',
            background: '#0f1117', borderRadius: '6px',
            border: '1px solid #1f2335'
          }}>
            <div style={{
              width: '24px', height: '24px', borderRadius: '50%',
              background: '#ef444422', color: '#ef4444',
              fontSize: '12px', fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0
            }}>
              {index + 1}
            </div>
            <div style={{ color: '#d1d5db', fontSize: '13px', lineHeight: 1.6 }}>
              {item}
            </div>
          </div>
        ))}
      </div>

      <div style={{
        borderTop: '1px solid #2a2d3e', marginTop: '16px', paddingTop: '12px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: '8px'
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{
            background: '#0f1117', border: '1px solid #2a2d3e',
            borderRadius: '6px', padding: '4px 12px'
          }}>
            <span style={{ fontSize: '11px', color: '#8b8fa8', display: 'block' }}>Detection Window</span>
            <span style={{ fontSize: '13px', color: '#ffffff', fontWeight: 600 }}>
              W{detectionWindow.window_number}
            </span>
          </div>
          <div style={{
            background: '#0f1117', border: '1px solid #2a2d3e',
            borderRadius: '6px', padding: '4px 12px'
          }}>
            <span style={{ fontSize: '11px', color: '#8b8fa8', display: 'block' }}>R Score</span>
            <span style={{ fontSize: '13px', color: '#ffffff', fontWeight: 600 }}>{detectionWindow.R_score.toFixed(2)}</span>
          </div>
          <div style={{
            background: '#0f1117', border: '1px solid #2a2d3e',
            borderRadius: '6px', padding: '4px 12px'
          }}>
            <span style={{ fontSize: '11px', color: '#8b8fa8', display: 'block' }}>Confidence</span>
            <span style={{ fontSize: '13px', color: '#ffffff', fontWeight: 600 }}>{Math.round(detectionWindow.confidence * 100)}%</span>
          </div>
        </div>
        <div style={{ color: '#4a4d5e', fontSize: '10px', textAlign: 'right', lineHeight: 1.6 }}>
          Detection by deterministic math only<br />
          A model may explain — never detect
        </div>
      </div>
    </div>
  )
}
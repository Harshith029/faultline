import { useState } from 'react'

const NODES = [
  { id: 'service-a', label: 'service-a', x: 80, y: 140, role: 'Gateway' },
  { id: 'service-b', label: 'service-b', x: 280, y: 140, role: 'Auth/Pool' },
  { id: 'service-c', label: 'service-c', x: 280, y: 260, role: 'Cache' },
  { id: 'service-d', label: 'service-d', x: 480, y: 100, role: 'API' },
  { id: 'service-e', label: 'service-e', x: 480, y: 260, role: 'Storage' },
  { id: 'service-f', label: 'service-f', x: 680, y: 100, role: 'Frontend' },
  { id: 'service-g', label: 'service-g', x: 680, y: 220, role: 'Worker' },
]

const EDGES = [
  { from: 'service-a', to: 'service-b' },
  { from: 'service-b', to: 'service-d' },
  { from: 'service-b', to: 'service-c' },
  { from: 'service-d', to: 'service-f' },
  { from: 'service-d', to: 'service-g' },
  { from: 'service-c', to: 'service-e' },
]

const NODE_COLORS = {
  healthy: { fill: '#10261b', stroke: '#10b981', text: '#34d399' },
  affected: { fill: '#2c200d', stroke: '#f59e0b', text: '#fbbf24' },
  root: { fill: '#2d1519', stroke: '#ef4444', text: '#f87171' },
}

const getNodeStatus = (serviceId, activeWindow) => {
  if (activeWindow < 8) return 'healthy'
  if (serviceId === 'service-b') return 'root'
  if (serviceId === 'service-d') return 'affected'
  if (serviceId === 'service-f') return 'affected'
  return 'healthy'
}

const getEdgeStatus = (fromId, toId, activeWindow) => {
  if (activeWindow < 8) return 'normal'
  const cascadeEdges = [
    ['service-b', 'service-d'],
    ['service-d', 'service-f'],
  ]
  const isCascade = cascadeEdges.some(([from, to]) => from === fromId && to === toId)
  return isCascade ? 'cascade' : 'normal'
}

const getNodeTooltip = (nodeId, activeWindow, windows) => {
  const window = windows.find((item) => item.window_number === activeWindow)
  const status = getNodeStatus(nodeId, activeWindow)

  const statusLabels = {
    root: 'ROOT CAUSE',
    affected: 'CASCADE VICTIM',
    healthy: 'HEALTHY',
  }

  if (nodeId === 'service-b' && activeWindow >= 8) {
    return {
      status: statusLabels[status],
      details: [
        `P99 Latency: z=${window?.metrics?.p99_latency_z?.toFixed(1)} sigma`,
        `Retry Rate: z=${window?.metrics?.retry_rate_z?.toFixed(1)} sigma`,
        `Error Rate: z=${window?.metrics?.error_rate_z?.toFixed(1)} sigma`,
        `R Score: ${window?.R_score?.toFixed(2)}`,
        'Root cause: Connection pool exhaustion',
      ],
    }
  }

  if ((nodeId === 'service-d' || nodeId === 'service-f') && activeWindow >= 8) {
    return {
      status: statusLabels[status],
      details: [
        'Receiving degraded responses from service-b',
        'Latency elevated due to upstream exhaustion',
        'Will self-recover when service-b pool drains',
      ],
    }
  }

  return {
    status: statusLabels.healthy,
    details: [
      'Operating within normal parameters',
      'No drift signals detected',
      'Isolated from cascade path',
    ],
  }
}

const buildEdgePath = (fromNode, toNode) => {
  const startX = fromNode.x + 28
  const startY = fromNode.y
  const endX = toNode.x - 28
  const endY = toNode.y
  const delta = Math.max((endX - startX) * 0.5, 44)

  return `M ${startX} ${startY} C ${startX + delta} ${startY}, ${endX - delta} ${endY}, ${endX} ${endY}`
}

export default function ServiceArchitectureMap({ windows, activeWindow }) {
  const [selectedNode, setSelectedNode] = useState(null)

  const load = activeWindow / 12
  let loadColor = '#10b981'
  if (load >= 0.7) loadColor = '#ef4444'
  else if (load >= 0.5) loadColor = '#f59e0b'

  const tooltip = selectedNode ? getNodeTooltip(selectedNode, activeWindow, windows) : null
  const activeLabel = activeWindow >= 8 ? 'Cascade active' : 'Topology nominal'

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
            Dependency topology
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">
            Service Architecture
          </div>
          <div className="mt-2 max-w-xl text-sm text-slate-400">
            Observe the dependency chain as pressure travels from the root service through downstream systems.
          </div>
        </div>

        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ${
          activeWindow >= 8
            ? 'bg-rose-500/15 text-rose-200 ring-rose-400/30'
            : 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30'
        }`}>
          <span className={`h-2.5 w-2.5 rounded-full ${
            activeWindow >= 8
              ? 'bg-rose-400 shadow-[0_0_18px_rgba(251,113,133,0.7)]'
              : 'bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.65)]'
          }`} />
          {activeLabel}
        </span>
      </div>

      <div className="chart-shell rounded-[28px] border border-white/10 p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10">
            Selected window: W{activeWindow}
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10">
            Traffic load {Math.round(load * 100)}%
          </span>
          <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10">
            Click a node for details
          </span>
        </div>

        <svg width="100%" viewBox="0 0 800 320" preserveAspectRatio="xMidYMid meet">
          <style>{`
            @keyframes dash {
              to { stroke-dashoffset: -18; }
            }
            @keyframes pulse {
              0%, 100% { opacity: 0.15; r: 28; }
              50% { opacity: 0.4; r: 32; }
            }
          `}</style>

          <defs>
            <linearGradient id="mapBackdrop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#10192d" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#060b14" stopOpacity="0.82" />
            </linearGradient>
            <filter id="nodeGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#38bdf8" floodOpacity="0.16" />
            </filter>
            <filter id="selectedNodeGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="10" floodColor="#ffffff" floodOpacity="0.25" />
            </filter>
            <marker id="arrowNormal" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#2a2d3e" />
            </marker>
            <marker id="arrowCascade" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#ef4444" />
            </marker>
          </defs>

          <rect x="0" y="0" width="800" height="320" rx="24" fill="url(#mapBackdrop)" />

          {Array.from({ length: 7 }).map((_, index) => (
            <line
              key={`grid-h-${index}`}
              x1="40"
              y1={40 + (index * 40)}
              x2="760"
              y2={40 + (index * 40)}
              stroke="rgba(148,163,184,0.08)"
              strokeDasharray="3 8"
            />
          ))}

          {Array.from({ length: 10 }).map((_, index) => (
            <line
              key={`grid-v-${index}`}
              x1={80 + (index * 70)}
              y1="30"
              x2={80 + (index * 70)}
              y2="290"
              stroke="rgba(148,163,184,0.06)"
              strokeDasharray="3 10"
            />
          ))}

          {EDGES.map((edge, index) => {
            const fromNode = NODES.find((node) => node.id === edge.from)
            const toNode = NODES.find((node) => node.id === edge.to)
            const status = getEdgeStatus(edge.from, edge.to, activeWindow)
            const isCascade = status === 'cascade'

            return (
              <path
                key={`edge-${index}`}
                d={buildEdgePath(fromNode, toNode)}
                stroke={isCascade ? '#ef4444' : '#2a2d3e'}
                strokeWidth={isCascade ? 3 : 2}
                strokeDasharray={isCascade ? '6 3' : 'none'}
                markerEnd={isCascade ? 'url(#arrowCascade)' : 'url(#arrowNormal)'}
                fill="none"
                style={isCascade ? { animation: 'dash 1.5s linear infinite' } : undefined}
              />
            )
          })}

          <text x={280} y={180} fontSize={8} fill="#8b8fa8" textAnchor="middle">
            Traffic Load
          </text>
          <rect x={248} y={184} width={64} height={5} rx={3} fill="rgba(148,163,184,0.16)" />
          <rect x={248} y={184} width={64 * load} height={5} rx={3} fill={loadColor} />

          {NODES.map((node) => {
            const status = getNodeStatus(node.id, activeWindow)
            const colors = NODE_COLORS[status]
            const isSelected = selectedNode === node.id
            const showPulse = (status === 'root' || status === 'affected') && activeWindow >= 8

            return (
              <g
                key={node.id}
                onClick={() => setSelectedNode(selectedNode === node.id ? null : node.id)}
                cursor="pointer"
              >
                {showPulse && (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={28}
                    fill="none"
                    stroke={colors.stroke}
                    strokeWidth={2}
                    style={{ animation: 'pulse 2s ease-in-out infinite' }}
                  />
                )}

                <circle
                  cx={node.x}
                  cy={node.y}
                  r={24}
                  fill={colors.fill}
                  stroke={colors.stroke}
                  strokeWidth={isSelected ? 3 : 2}
                  filter={isSelected ? 'url(#selectedNodeGlow)' : 'url(#nodeGlow)'}
                />

                <text
                  x={node.x}
                  y={node.y + 4}
                  fontSize={10}
                  fontWeight={600}
                  fill={colors.text}
                  textAnchor="middle"
                >
                  {node.label.replace('service-', 'svc-')}
                </text>

                <text
                  x={node.x}
                  y={node.y + 16}
                  fontSize={8}
                  fill="#8b8fa8"
                  textAnchor="middle"
                >
                  {node.role}
                </text>

                <circle cx={node.x + 18} cy={node.y - 18} r={4} fill={colors.stroke} />
              </g>
            )
          })}
        </svg>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-emerald-500/12 px-3 py-1 text-emerald-200 ring-1 ring-emerald-400/20">
            Healthy
          </span>
          <span className="rounded-full bg-amber-500/12 px-3 py-1 text-amber-200 ring-1 ring-amber-400/20">
            Cascade victim
          </span>
          <span className="rounded-full bg-rose-500/12 px-3 py-1 text-rose-200 ring-1 ring-rose-400/20">
            Root cause
          </span>
        </div>
        <span className="text-xs text-slate-500">
          Topology updates are keyed to the active window.
        </span>
      </div>

      {tooltip && (
        <div className="insight-panel mt-4 rounded-[24px] border border-white/10 bg-gradient-to-br from-slate-900/92 to-slate-950/85 px-5 py-4">
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
            Node detail
          </div>
          <div className="mt-2 text-lg font-semibold text-white">
            {tooltip.status}
          </div>
          {tooltip.details.map((detail, index) => (
            <div key={`detail-${index}`} className="mt-3 flex items-start gap-3 text-sm text-slate-300">
              <span className="mt-1 h-2 w-2 rounded-full bg-sky-400" />
              <span>{detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

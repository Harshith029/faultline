import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import MetadataBar from '../src/components/MetadataBar'

const baseProps = { serviceId: 'B', activeWindow: 6, triggered: false, outage: false, totalWindows: 12 }

describe('MetadataBar', () => {
  it('labels the bundled scenario as sample data, never as live telemetry', () => {
    render(<MetadataBar {...baseProps} source="scenario" signalCount={0} />)
    expect(screen.getByText('Sample scenario')).toBeInTheDocument()
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument()
  })

  it('labels CloudWatch data as live', () => {
    render(<MetadataBar {...baseProps} source="live" signalCount={0} />)
    expect(screen.getByText('Live · CloudWatch')).toBeInTheDocument()
  })

  it('derives the status from the data, not from how far through the timeline it is', () => {
    // Window 6 of the scenario used to read "Instability forming" whatever the data said.
    const { rerender } = render(<MetadataBar {...baseProps} source="live" signalCount={0} />)
    expect(screen.getByText('System nominal')).toBeInTheDocument()

    rerender(<MetadataBar {...baseProps} source="live" signalCount={1} />)
    expect(screen.getByText('Instability forming')).toBeInTheDocument()

    rerender(<MetadataBar {...baseProps} source="live" signalCount={2} triggered />)
    expect(screen.getByText('Convergence detected')).toBeInTheDocument()
  })
})

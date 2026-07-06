const API_URL = import.meta.env.VITE_API_URL

export async function fetchTimeline(serviceId = 'B') {
  if (!API_URL) throw new Error('VITE_API_URL is not configured')
  const res = await fetch(`${API_URL}/timeline?service_id=${encodeURIComponent(serviceId)}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function fetchLiveTelemetry() {
  if (!API_URL) throw new Error('VITE_API_URL is not configured')
  const res = await fetch(`${API_URL}/timeline?source=live`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

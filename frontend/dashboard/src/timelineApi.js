// opus
const API_URL = import.meta.env.VITE_API_URL

export async function fetchTimeline(serviceId = 'B') {
  const res = await fetch(`${API_URL}/timeline?service_id=${serviceId}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}
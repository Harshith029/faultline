export class WindowBuffer {
  constructor(capacity = 60) {
    if (!Number.isInteger(capacity) || capacity < 3) {
      throw new Error(`WindowBuffer capacity must be an integer >= 3, got ${capacity}`)
    }
    this.capacity = capacity
    this.series = new Map()
  }

  push(service, sample) {
    let list = this.series.get(service)
    if (!list) {
      list = []
      this.series.set(service, list)
    }
    list.push(sample)
    if (list.length > this.capacity) list.splice(0, list.length - this.capacity)
    return list.length
  }

  get(service) {
    return this.series.get(service) ?? []
  }

  size(service) {
    return this.get(service).length
  }

  services() {
    return [...this.series.keys()]
  }

  clear(service) {
    if (service === undefined) this.series.clear()
    else this.series.delete(service)
  }
}

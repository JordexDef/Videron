export const mapLabelLimit = 120

// Count Unicode code points so an emoji takes one place in the label.
export function normalizeMapLabel(value) {
  if (typeof value !== 'string') return ''
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').trim()
  const chars = Array.from(line.slice(0, mapLabelLimit * 2))
  return chars.slice(0, mapLabelLimit).join('').replace(/[\ud800-\udfff]/gu, '\ufffd').trimEnd()
}

export function validMapLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= mapLabelLimit * 2 &&
    value === normalizeMapLabel(value)
}

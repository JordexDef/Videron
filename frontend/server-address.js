const preferenceKey = 'videron.last-sync-server.v1'
let lastAddress = ''

// Store only an HTTPS authority returned by the native connection API.
// Keep the explicit port so reopening a direct or tunnel connection uses the same endpoint.
function endpoint(address) {
  if (typeof address !== 'string' || !/^https:\/\/[^\s/\\@?#%]+\/?$/i.test(address)) return ''
  try {
    const url = new URL(address)
    if (!url.hostname || url.port === '0' || /:\/?$/.test(address)) return ''
    return 'https://' + url.hostname + ':' + (url.port || '443')
  } catch { return '' }
}

export function lastServerAddress() {
  if (!lastAddress) {
    try { lastAddress = endpoint(localStorage.getItem(preferenceKey)) } catch {}
  }
  return lastAddress
}

export function rememberServerAddress(address) {
  const next = endpoint(address)
  if (!next || next === lastServerAddress()) return
  lastAddress = next
  try { localStorage.setItem(preferenceKey,next) } catch {}
}

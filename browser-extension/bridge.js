(() => {
  const channel = 'ai-job-tracker-linkedin'
  if (!['5173', '4173'].includes(location.port)) return

  window.addEventListener('message', async event => {
    const request = event.data
    if (event.source !== window || event.origin !== location.origin ||
        request?.channel !== channel || request.type !== 'request' || typeof request.id !== 'string') return

    let result
    try {
      result = await chrome.runtime.sendMessage({ action: request.action, url: request.url, id: request.id, company: request.company })
    } catch {
      result = { error: 'Reload the tracker after updating the LinkedIn Import extension.' }
    }
    window.postMessage({ channel, type: 'response', id: request.id, ...result }, location.origin)
  })
})()

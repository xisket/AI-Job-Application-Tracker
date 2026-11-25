import { extraction, safeUrl, type Draft } from './model'
import { cleanDescriptionHtml } from './description-html'

const channel = 'ai-job-tracker-linkedin'

export function isLinkedInPosting(url: string) {
  return /^https?:\/\/www\.linkedin\.com\/jobs\/view\/(?:[^/?#]+-)?\d+\/?(?:[?#]|$)/i.test(url)
}

function exchange(action: 'ping' | 'read' | 'read-open', signal: AbortSignal, url?: string, company?: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    signal.throwIfAborted()
    const id = crypto.randomUUID()
    const timeout = window.setTimeout(() => {
      notifyCancel()
      cleanup()
      reject(new Error(action === 'ping'
        ? 'Load the Job Tracker LinkedIn Import extension in this browser, then reload the tracker.'
        : 'The LinkedIn reader did not respond in time.'))
    }, action === 'ping' ? 1500 : 22000)

    function cleanup() {
      window.clearTimeout(timeout)
      window.removeEventListener('message', receive)
      signal.removeEventListener('abort', cancel)
    }

    function cancel() {
      notifyCancel()
      cleanup()
      reject(signal.reason)
    }

    function notifyCancel() {
      if (action !== 'ping') window.postMessage({ channel, type: 'request', action: 'cancel', id }, location.origin)
    }

    function receive({ source, origin, data }: MessageEvent) {
      if (source !== window || origin !== location.origin ||
          data?.channel !== channel || data.type !== 'response' || data.id !== id) return
      cleanup()
      if (typeof data.error === 'string') reject(new Error(data.error))
      else resolve(data)
    }

    signal.addEventListener('abort', cancel, { once: true })
    window.addEventListener('message', receive)
    window.postMessage({ channel, type: 'request', action, id, url, company }, location.origin)
  })
}

export async function checkLinkedInReader(signal: AbortSignal) {
  const response = await exchange('ping', signal)
  if (response.ready !== true) throw new Error('The LinkedIn Import extension is unavailable.')
  if (response.protocol !== 7) {
    throw new Error('An outdated LinkedIn Import extension is running. Reload the extension from this project, then refresh the tracker.')
  }
}

export async function readLinkedInPosting(url: string, company: string, signal: AbortSignal, fromOpenTab = false) {
  const response = await exchange(fromOpenTab ? 'read-open' : 'read', signal, url, company)
  const text = typeof response.text === 'string' ? response.text.trim() : ''
  if (!text) throw new Error('No job description was available in the LinkedIn tab.')
  let fields: Partial<Draft> = {}
  if (response.fields && typeof response.fields === 'object') {
    try {
      fields = extraction(JSON.stringify(response.fields))
    } catch {
      // Keep the job description when the page has no usable structured fields.
    }
  }
  return { text: text.slice(0, 45000), html: typeof response.html === 'string' ? cleanDescriptionHtml(response.html) : '',
    logo: typeof response.logo === 'string' && response.logo.length <= 4096 ? safeUrl(response.logo) : '',
    logoCompany: typeof response.logoCompany === 'string' ? response.logoCompany : '', fields }
}

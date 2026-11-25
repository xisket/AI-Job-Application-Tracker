const trackerOrigins = new Set([
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:4173', 'http://127.0.0.1:4173',
])
const pending = new Map()

function getJobTarget(input) {
  if (typeof input !== 'string') return
  let url
  try { url = new URL(input) } catch { return }
  if (!['http:', 'https:'].includes(url.protocol) || url.host !== 'www.linkedin.com' ||
      url.username || url.password) return
  const id = url.pathname.match(/^\/jobs\/view\/(?:[^/]+-)?(\d+)\/?$/)?.[1]
  if (id) return { id, url: 'https://www.linkedin.com' + url.pathname }
}

function matchesJob(input, id) {
  if (getJobTarget(input)?.id === id) return true
  if (typeof input !== 'string') return false
  const url = new URL(input)
  return url.origin === 'https://www.linkedin.com' && url.pathname.startsWith('/jobs/') &&
    url.searchParams.get('currentJobId') === id
}

function readJob(expectedId, expectedCompany) {
  if (location.origin !== 'https://www.linkedin.com') return
  if (/^\/(?:login|uas|authwall|checkpoint)(?:\/|$)/.test(location.pathname)) return { status: 'sign-in' }
  const viewId = location.pathname.match(/^\/jobs\/view\/(?:[^/]+-)?(\d+)\/?$/)?.[1]
  const currentId = new URLSearchParams(location.search).get('currentJobId')
  if (viewId !== expectedId && !(location.pathname.startsWith('/jobs/') && currentId === expectedId)) return { status: 'redirected' }

  const text = (node, max) => (node?.innerText || node?.textContent || '').trim().slice(0, max)
  const first = (selector, max = 160) => text(document.querySelector(selector), max)
  function findPosting(value) {
    if (!value || typeof value !== 'object') return
    if ([value['@type']].flat().includes('JobPosting')) return value
    for (const child of Object.values(value)) {
      const posting = findPosting(child)
      if (posting) return posting
    }
  }
  let posting
  for (const block of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { posting = findPosting(JSON.parse(block.textContent)) } catch { continue }
    if (posting) break
  }

  function plain(html, max) {
    if (typeof html !== 'string') return ''
    const template = document.createElement('template')
    template.innerHTML = html.replace(/<\/(?:p|li|div)>|<br\s*\/?\s*>/gi, '$&\n')
    return text(template.content, max)
  }
  const heading = [...document.querySelectorAll('h2, h3, [role="heading"]')]
    .find(node => /^(about the job|about this job|acerca del empleo|acerca del puesto|sobre el empleo)$/i.test(text(node, 80)))
  const headingText = text(heading, 80)
  function descriptionByHeading() {
    for (let node = heading, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const content = text(node.nextElementSibling, 45000)
      if (content.length >= 40) return content
      const parent = node.parentElement
      if (!parent || parent.matches('main, body, [role="main"]')) break
      const combined = text(parent, 45000)
      if (combined.startsWith(headingText) && combined.length >= headingText.length + 40)
        return combined.slice(headingText.length).trim()
    }
    return ''
  }
  const descriptionNode = document.querySelector('#job-details, [data-testid="job-details"], [data-testid="job-description"], .jobs-box__html-content, .jobs-description-content__text, .jobs-description__content, .show-more-less-html__markup')
  const description = text(descriptionNode, 45000) ||
    plain(posting?.description, 45000) ||
    descriptionByHeading()
  if (!description) {
    const notices = [...document.querySelectorAll('h1, h2, [role="alert"]')].map(node => text(node, 200))
    if (notices.some(value => /no longer available|job (?:has been|was) removed|(?:empleo|puesto) ya no est[aá] disponible/i.test(value)))
      return { status: 'unavailable' }
    return { status: 'no-description' }
  }

  const role = first('.job-details-jobs-unified-top-card__job-title, .top-card-layout__title') || plain(posting?.title, 160)
  const company = first('.job-details-jobs-unified-top-card__company-name, .topcard__org-name-link') ||
    plain(posting?.hiringOrganization?.name, 160)
  const companyImages = [...document.querySelectorAll('img[alt]')].flatMap(node => {
    const name = node.alt.match(/^company logo for,?\s+(.+?)\.?$/i)?.[1]
    if (!name) return []
    const url = [node.currentSrc, node.src, node.getAttribute('data-src'),
      ...(node.getAttribute('srcset') ?? '').split(',').map(candidate => candidate.trim().split(/\s+/)[0])]
      .find(value => /^https:\/\/media\.licdn\.com\/[^?#]*\/company-logo_/i.test(value ?? ''))
    return url ? [{ name, url }] : []
  })
  const companyKey = value => (value ?? '').normalize('NFKC').trim().replace(/\.$/, '').toLowerCase()
  const expectedKey = companyKey(expectedCompany) || companyKey(company)
  const matchingImage = expectedKey ? companyImages.find(image => companyKey(image.name) === expectedKey) :
    companyImages.length === 1 ? companyImages[0] : undefined
  const logoNode = document.querySelector('.job-details-jobs-unified-top-card__company-logo img, img.jobs-company__logo, .top-card-layout__entity-image img, img.top-card-layout__entity-image')
  const organizationLogo = posting?.hiringOrganization?.logo
  const structuredLogo = typeof organizationLogo === 'string' ? organizationLogo : organizationLogo?.url
  const visibleLogo = [logoNode?.currentSrc, logoNode?.src]
    .find(value => /^https:\/\/media\.licdn\.com\/[^?#]*\/company-logo_/i.test(value ?? ''))
  const logo = matchingImage?.url || (/^https:\/\//i.test(structuredLogo ?? '') ? structuredLogo : '') || visibleLogo || ''
  const address = [posting?.jobLocation].flat()[0]?.address
  const locationText = first('.job-details-jobs-unified-top-card__primary-description-container .tvm__text:first-child, .topcard__flavor--bullet') ||
    [address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(value => typeof value === 'string').join(', ')
  const arrangement = posting?.jobLocationType === 'TELECOMMUTE' ? 'Remote' :
    [...document.querySelectorAll('.job-details-preferences-and-skills__pill')]
      .map(node => text(node, 80)).find(value => /^(remote|hybrid|on[- ]site)$/i.test(value)) || ''
  const date = value => typeof value === 'string' ? value.slice(0, 10) : ''
  const salary = posting?.baseSalary
  const rate = salary?.value
  const amount = typeof rate === 'number' ? rate : rate?.value ?? [rate?.minValue, rate?.maxValue].filter(Number.isFinite).join(' - ')
  return {
    text: description,
    logo,
    logoCompany: matchingImage?.name || company,
    html: (descriptionNode?.innerHTML || (typeof posting?.description === 'string' ? posting.description : '')).slice(0, 120000),
    fields: { role, company: company || matchingImage?.name || '', location: locationText, arrangement, posted: date(posting?.datePosted),
      deadline: date(posting?.validThrough), requirements: plain(posting?.qualifications, 3000),
      salary: amount ? [salary?.currency, amount, rate?.unitText].filter(Boolean).join(' ') : '' },
  }
}

async function readOpenTab(target, windowId, signal) {
  const tabs = await chrome.tabs.query({ windowId, url: 'https://www.linkedin.com/jobs/*' })
  const matching = tabs.filter(tab => matchesJob(tab.url, target.id))
  if (!matching.length) return { error: 'Open this exact LinkedIn posting in another tab in this window, wait for the description, and retry.' }
  for (const tab of matching) {
    signal.throwIfAborted()
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: readJob, args: [target.id, target.company],
    }).catch(() => [])
    if (frame?.result?.text) return frame.result
  }
  return { error: 'The extension found the open LinkedIn tab but could not locate its job description.' }
}

async function readInBackground(target, windowId, signal) {
  const tab = await chrome.tabs.create({
    url: target.url, active: false, windowId,
  })
  let closing
  const closeTab = () => closing ??= chrome.tabs.remove(tab.id).catch(() => {})
  signal.addEventListener('abort', closeTab, { once: true })
  try {
    signal.throwIfAborted()
    const deadline = Date.now() + 18000
    let lastStatus
    let injectionFailed = false
    let posting
    let waitForLogoUntil
    while (!signal.aborted && Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id)
      const url = current.url
      if (url && /^https:\/\/www\.linkedin\.com\/(?:login|uas|authwall|checkpoint)(?:[/?#]|$)/.test(url)) {
        lastStatus = 'sign-in'
        break
      }
      if (url?.startsWith('https://www.linkedin.com/jobs/')) {
        try {
          const [frame] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, func: readJob, args: [target.id, target.company],
          })
          if (frame?.result?.text) {
            posting = frame.result
            if (posting.logo) return posting
            waitForLogoUntil ??= Date.now() + 3000
          }
          if (posting && Date.now() >= waitForLogoUntil) return posting
          lastStatus = frame?.result?.status ?? lastStatus
          if (lastStatus === 'unavailable' || lastStatus === 'sign-in') break
        } catch {
          injectionFailed = true
        }
      } else if (url?.startsWith('https://www.linkedin.com/') && current.status === 'complete') {
        lastStatus = 'redirected'
      }
      await new Promise(resolve => setTimeout(resolve, 600))
    }
    if (posting) return posting
    const errors = {
      'sign-in': 'LinkedIn asked for sign-in or verification. Open the posting in this browser, complete that step, and retry.',
      'unavailable': 'LinkedIn says this job is no longer available.',
      'redirected': 'LinkedIn redirected away from this job. Open the posting in this browser to check where it leads.',
      'no-description': 'The LinkedIn posting opened, but its job description was not readable. Open it in this browser to check whether the description is visible.',
    }
    return { error: errors[lastStatus] ?? (injectionFailed
      ? 'The extension could not read the LinkedIn tab. Check that its site access is allowed for LinkedIn.'
      : 'The LinkedIn tab did not finish loading. Open the posting in this browser to check its status.') }
  } finally {
    signal.removeEventListener('abort', closeTab)
    await closeTab()
  }
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.frameId !== 0 || !trackerOrigins.has(sender.origin) || !sender.tab) return
  if (request?.action === 'ping') {
    respond({ ready: true, protocol: 7 })
    return
  }
  if (typeof request?.id !== 'string') return
  const key = sender.tab.id + ':' + request.id
  if (request.action === 'cancel') {
    pending.get(key)?.abort()
    respond({ canceled: true })
    return
  }
  if (request.action !== 'read' && request.action !== 'read-open') return
  const target = getJobTarget(request.url)
  if (!target || pending.size >= 2 || pending.has(key)) {
    respond({ error: target ? 'The LinkedIn reader is already busy.' : 'This URL is not a supported LinkedIn job posting.' })
    return
  }

  const controller = new AbortController()
  target.company = typeof request.company === 'string' ? request.company.slice(0, 160) : ''
  pending.set(key, controller)
  const read = request.action === 'read-open' ? readOpenTab : readInBackground
  read(target, sender.tab.windowId, controller.signal)
    .then(respond, () => respond({ error: 'The background tab could not be read.' }))
    .finally(() => { pending.delete(key) })
  return true
})

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { safeUrl } from './model'

export function companyLogoSource(value: string) {
  return value.length <= 350000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/]+=*$/i.test(value)
    ? value : value.length <= 4096 ? safeUrl(value) : ''
}

export function CompanyIcon({ company, logo }: { company: string; logo?: string }) {
  const source = companyLogoSource(logo ?? '')
  const [failed, setFailed] = useState('')
  return <span className="company-icon" aria-hidden="true">
    {source && failed !== source ? <img src={source} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(source)} />
      : Array.from(company.trim())[0]?.toUpperCase()}
  </span>
}

export function CompanyLogoEditor({ company, logo, onChange }: {
  company: string
  logo: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <div className="company-logo-trigger">
    <CompanyIcon company={company} logo={logo} />
    <button type="button" className="note-icon company-logo-change" aria-haspopup="dialog"
      aria-label="Change company logo" title="Change company logo" onClick={() => setOpen(true)}>✎</button>
    {open && <CompanyLogoDialog company={company} initialLogo={logo} onClose={() => setOpen(false)}
      onApply={value => { onChange(value); setOpen(false) }} />}
  </div>
}

function CompanyLogoDialog({ company, initialLogo, onClose, onApply }: {
  company: string
  initialLogo: string
  onClose: () => void
  onApply: (value: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [logo, setLogo] = useState(initialLogo)
  const [problem, setProblem] = useState('')
  const [reading, setReading] = useState(false)
  useEffect(() => {
    const popup = dialog.current
    popup?.showModal()
    return () => popup?.close()
  }, [])

  function readImage(file: File) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || !file.size || file.size > 256 * 1024) {
      setProblem('Choose a PNG, JPEG, WebP, or GIF up to 256 KB.')
      return
    }
    const reader = new FileReader()
    setProblem('')
    setReading(true)
    reader.onload = () => { setLogo(String(reader.result)); setReading(false) }
    reader.onerror = () => { setProblem('Could not read this image.'); setReading(false) }
    reader.readAsDataURL(file)
  }

  return createPortal(<dialog className="company-logo-dialog" ref={dialog} aria-labelledby="company-logo-title" onCancel={event => {
    event.preventDefault()
    event.stopPropagation()
    if (!reading) onClose()
  }}>
    <form onSubmit={event => {
      event.preventDefault()
      event.stopPropagation()
      if (reading) return
      const value = logo.trim()
      if (value && !companyLogoSource(value)) {
        setProblem('Enter a valid HTTP or HTTPS logo URL, or upload an image.')
        return
      }
      onApply(value)
    }}>
      <header className="dialog-head">
        <h2 id="company-logo-title">Company logo</h2>
        <button type="button" aria-label="Close logo editor" disabled={reading} onClick={onClose}>×</button>
      </header>
      <div className="dialog-content company-logo-options">
        <CompanyIcon company={company} logo={logo} />
        <label>Company logo URL
          <input placeholder="Paste an image or its URL" value={logo.startsWith('data:') ? '' : logo}
            disabled={reading} maxLength={4096} onChange={event => { setProblem(''); setLogo(event.target.value) }}
            onPaste={event => {
              const file = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/'))
              if (file) { event.preventDefault(); readImage(file) }
            }} />
        </label>
        <div className="actions">
          <label>Upload logo<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={reading} onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) readImage(file)
          }} /></label>
          {logo && <button type="button" disabled={reading} onClick={() => { setProblem(''); setLogo('') }}>Remove logo</button>}
        </div>
        {problem && <small role="alert">{problem}</small>}
        <small>Save the application to update the logo for every application at this company.</small>
      </div>
      <footer className="dialog-foot">
        <button type="button" disabled={reading} onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={reading}>Apply logo</button>
      </footer>
    </form>
  </dialog>, document.body)
}

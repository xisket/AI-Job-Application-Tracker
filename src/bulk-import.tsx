import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { descriptionLimit, fetchPosting, parsePosting, previewSpreadsheet, saveImportedJob, type SpreadsheetRow } from './data'
import { blank, extractedFields, safeUrl, type Draft, type JobWrite, type RecordItem } from './model'
import { CompanyIcon } from './company-logo'
import { checkLinkedInReader, isLinkedInPosting, readLinkedInPosting } from './linkedin-browser'
import { descriptionMarkup } from './description-html'

type PreviewRow = SpreadsheetRow & {
  id: string
  draft: Draft
  selected: boolean
  status: string
  blocked: boolean
  postingUnavailable?: boolean
  companyLogo?: string
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'
const sameCompany = (name: string, postingName?: string) => !postingName ||
  name.normalize('NFKC').trim().replace(/\.$/, '').toUpperCase() === postingName.normalize('NFKC').trim().replace(/\.$/, '').toUpperCase()
const canReadLinkedIn = (row: PreviewRow) => isLinkedInPosting(row.draft.url) &&
  (row.postingUnavailable || (!row.blocked && !row.companyLogo))

function rowKey(applied: string, url: string, company: string, role: string) {
  let source = url
  if (source) {
    const link = new URL(source)
    link.hash = ''
    if (link.hostname === 'www.linkedin.com' && /^\/jobs\/view\/\d+\/?$/.test(link.pathname)) {
      link.search = ''
      link.pathname = link.pathname.replace(/\/$/, '')
    }
    source = link.href
  }
  return JSON.stringify([applied, source || [company.toLowerCase(), role.toLowerCase()]])
}

async function importId(key: string) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tracker-import:' + key)))
  hash[6] = (hash[6] & 15) | 128
  hash[8] = (hash[8] & 63) | 128
  const hex = Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function BulkImportDialog({ records, onClose, onSaved }: {
  records: RecordItem[]
  onClose: () => void
  onSaved: (item: RecordItem) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const abort = useRef<AbortController | null>(null)
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')
  const [summary, setSummary] = useState('')
  const [paste, setPaste] = useState<{ row: number; text: string } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [readingLinkedIn, setReadingLinkedIn] = useState(false)
  const ready = rows.filter(row => row.selected && !row.blocked)
  const linkedInRows = rows.filter(row => canReadLinkedIn(row) && (row.selected || row.blocked))

  useEffect(() => {
    dialog.current?.showModal()
    return () => abort.current?.abort()
  }, [])

  function update(id: number, update: Partial<PreviewRow>) {
    setRows(existing => existing.map(row => row.row === id ? { ...row, ...update } : row))
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const controller = new AbortController()
    abort.current = controller
    const { signal } = controller
    setReading(true)
    setRows([])
    setPaste(null)
    setProblem('')
    setSummary('')
    try {
      const source = await previewSpreadsheet(file, signal)
      const existing = new Set(records.map(({ job }) => rowKey(job.applied, safeUrl(job.url), job.company, job.role)))
      const ids = new Set(records.map(({ job }) => job.id))
      const keys = source.map(row => rowKey(row.applied, safeUrl(row.url), row.company, row.role))
      const importIds = await Promise.all(keys.map(importId))
      const preview = source.map((row, index): PreviewRow => {
        const url = safeUrl(row.url)
        const key = keys[index]
        const id = importIds[index]
        const duplicate = ids.has(id) || existing.has(key)
        const error = row.error || (row.url && !url ? 'Job URL is invalid.' : '')
        const blocked = duplicate || Boolean(error)
        if (!blocked) existing.add(key)
        return {
          ...row, id, selected: !blocked, blocked,
          draft: { ...blank, role: row.role.slice(0, extractedFields.role), company: row.company.slice(0, extractedFields.company),
            applied: row.applied, url, stage: 'Applied' },
          status: duplicate ? 'Already present' : error || (url ? 'Checking posting…' : 'No posting URL'),
        }
      })
      if (signal.aborted) return
      setRows(preview)
      if (!preview.length) setProblem('The file has no application rows.')

      const pending = preview.filter(row => !row.blocked)
      for (let index = 0; index < pending.length && !signal.aborted; index += 4) {
        await Promise.all(pending.slice(index, index + 4).map(async row => {
          let draft = row.draft
          let status = row.status
          let companyLogo = ''
          if (draft.url) {
            try {
              const posting = await fetchPosting(draft.url, signal)
              draft = { ...draft, ...posting.fields, role: draft.role || posting.fields.role || '',
                company: draft.company || posting.fields.company || '', applied: draft.applied,
                description: posting.text.slice(0, descriptionLimit), descriptionHtml: posting.html }
              if (sameCompany(draft.company, posting.fields.company)) companyLogo = posting.logo
              status = 'Posting details added'
            } catch {
              status = 'Posting unavailable. Spreadsheet values kept.'
            }
          }
          const blocked = !draft.role || !draft.company
          if (!signal.aborted) update(row.row, {
            draft, blocked, selected: !blocked, companyLogo, postingUnavailable: status.startsWith('Posting unavailable'),
            status: blocked ? 'Company name or job title is missing.' : status,
          })
        }))
      }
    } catch (error) {
      if (!signal.aborted) setProblem(message(error))
    } finally {
      if (!signal.aborted) setReading(false)
    }
  }

  async function applyPostingText() {
    const row = rows.find(item => item.row === paste?.row)
    const text = paste?.text.trim()
    if (!row || !text || extracting) return
    setExtracting(true)
    let fields: Partial<Draft> = {}
    let status = 'Posting details added'
    try {
      fields = await parsePosting(text)
    } catch {
      status = 'Posting description added. Structured details were unavailable.'
    }
    const draft = {
      ...row.draft, ...fields, role: row.draft.role || fields.role || '',
      company: row.draft.company || fields.company || '', applied: row.draft.applied, description: text, descriptionHtml: '',
    }
    const blocked = !draft.role || !draft.company
    update(row.row, { draft, blocked, selected: !blocked && (row.blocked || row.selected),
      postingUnavailable: blocked, status: blocked ? 'Company name or job title is missing.' : status })
    setPaste(null)
    setExtracting(false)
  }

  async function readLinkedInRows(targetRows: PreviewRow[], fromOpenTab = false) {
    const controller = new AbortController()
    abort.current = controller
    const { signal } = controller
    setReadingLinkedIn(true)
    setProblem('')
    setSummary('')
    try {
      await checkLinkedInReader(signal)
      let loaded = 0
      for (const row of targetRows) {
        signal.throwIfAborted()
        update(row.row, { status: fromOpenTab ? 'Reading the open LinkedIn tab…' : 'Reading LinkedIn in the background…' })
        try {
          const { fields, text, html, logo, logoCompany } = await readLinkedInPosting(row.draft.url, row.draft.company, signal, fromOpenTab)
          const draft = { ...row.draft, ...fields, role: row.draft.role || fields.role || '',
            company: row.draft.company || fields.company || '', applied: row.draft.applied, description: text, descriptionHtml: html }
          const blocked = !draft.role || !draft.company
          const companyLogo = sameCompany(draft.company, logoCompany || fields.company) ? logo || row.companyLogo : row.companyLogo
          update(row.row, { draft, blocked, selected: !blocked && (row.selected || row.blocked), postingUnavailable: blocked,
            companyLogo,
            status: blocked ? 'Company name or job title is missing.' :
              companyLogo ? 'LinkedIn details and company logo added' : 'LinkedIn details added. No matching company logo found.' })
          loaded++
        } catch (error) {
          if (signal.aborted) {
            update(row.row, { status: row.status })
            break
          }
          update(row.row, { status: message(error) })
        }
      }
      setSummary(`${signal.aborted ? 'Reading canceled. ' : ''}LinkedIn details added for ${loaded} of ${targetRows.length} rows.`)
    } catch (error) {
      if (!signal.aborted) setProblem(message(error))
    } finally {
      setReadingLinkedIn(false)
    }
  }

  async function saveSelected() {
    setSaving(true)
    setSummary('')
    let imported = 0
    let failed = 0
    for (const row of ready) {
      const stamp = new Date().toISOString()
      try {
        const result = await saveImportedJob({
          ...row.draft, id: row.id, updated: stamp, created: stamp,
          ...(row.companyLogo ? { companyLogoImport: row.companyLogo } : {}),
          history: [{ id: crypto.randomUUID(), date: stamp, kind: 'Added', text: 'Imported from spreadsheet' }],
          noteEntries: row.notes.map(text => ({ id: crypto.randomUUID(), text, created: stamp, updated: stamp })),
        } satisfies JobWrite)
        if (result) {
          onSaved(result)
          imported++
        }
        update(row.row, { blocked: true, selected: false, postingUnavailable: false, status: result ? 'Imported' : 'Already present' })
      } catch (error) {
        failed++
        update(row.row, { status: message(error) })
      }
    }
    setSummary(`${imported} imported.${failed ? ` ${failed} failed and can be retried.` : ''}`)
    setSaving(false)
  }

  return <dialog className="bulk-import" ref={dialog} aria-labelledby="bulk-title" onCancel={event => {
    event.preventDefault()
    if (!saving) onClose()
  }}>
    <form onSubmit={event => { event.preventDefault(); if (!reading && !readingLinkedIn && !saving && !paste && ready.length) void saveSelected() }}>
      <header className="dialog-head">
        <h2 id="bulk-title">Import applications</h2>
        <button type="button" onClick={onClose} disabled={saving}>Close</button>
      </header>
      <div className="dialog-content bulk-content">
        <label>Excel or CSV file
          <input type="file" accept=".xlsx,.csv" disabled={reading || readingLinkedIn || saving || extracting} onChange={event => void chooseFile(event)} />
        </label>
        <details className="bulk-linkedin-setup" open={/Load the Job Tracker|outdated LinkedIn Import/.test(problem) || undefined}>
          <summary>Set up background LinkedIn import</summary>
          <ol>
            <li>In the Chrome or Edge profile running this tracker, open the Extensions page (<code>chrome://extensions</code> or <code>edge://extensions</code>).</li>
            <li>Turn on <strong>Developer mode</strong> and click <strong>Load unpacked</strong>.</li>
            <li>Choose the <code>browser-extension</code> folder in the tracker project.</li>
            <li>Sign in to LinkedIn in that browser profile and reload the tracker.</li>
            <li>Upload your spreadsheet. After the public link check, select the available rows and click <strong>Read LinkedIn in background</strong>.</li>
            <li>If a background tab cannot see the description, open that row’s posting in this browser. Once the description is visible, return to the tracker and click <strong>Read open tab</strong> on that row.</li>
          </ol>
          <small>After an update, click Reload on the extension card and refresh the tracker tab. Use localhost or 127.0.0.1 on port 5173 or 4173.</small>
        </details>
        {(linkedInRows.length > 0 || readingLinkedIn) && <div className="actions">
          <button type="button" disabled={reading || readingLinkedIn || saving || !!paste}
            onClick={() => void readLinkedInRows(linkedInRows)}>{readingLinkedIn ? 'Reading LinkedIn…' : 'Read LinkedIn in background'}</button>
          {readingLinkedIn && <button type="button" onClick={() => abort.current?.abort()}>Cancel reading</button>}
        </div>}
        {problem && <p role="alert" className="notice">{problem}</p>}
        {reading && <p role="status">Reading the file and checking public posting links…</p>}
        {summary && <p role="status" className="notice">{summary}</p>}
        {rows.length > 0 && <div className="bulk-grid" tabIndex={0} role="region" aria-label="Import preview">
          <table>
            <thead><tr>
              <th scope="col"><input type="checkbox" aria-label="Select all importable rows"
                disabled={reading || readingLinkedIn || saving || rows.every(row => row.blocked)}
                checked={ready.length > 0 && rows.every(row => row.blocked || row.selected)}
                onChange={event => {
                  const selected = event.target.checked
                  setRows(existing => existing.map(row => row.blocked ? row : { ...row, selected }))
                }} /></th>
              <th scope="col">Application Date</th><th scope="col">Contact Email <small>(ignored)</small></th>
              <th scope="col">Contact Phone Number <small>(ignored)</small></th><th scope="col">Company Name</th>
              <th scope="col">Job Title</th><th scope="col">Job Url</th><th scope="col">Resume Name <small>(ignored)</small></th>
              <th scope="col">Question And Answers</th><th scope="col">Posting details and status</th>
            </tr></thead>
            <tbody>{rows.map(row => <tr key={row.row}>
              <td><input type="checkbox" aria-label={`Import row ${row.row}`} checked={row.selected}
                disabled={reading || readingLinkedIn || saving || row.blocked} onChange={event => update(row.row, { selected: event.target.checked })} /></td>
              <td>{row.applied.replace('T', ' ')}</td><td>{row.contactEmail}</td><td>{row.contactPhoneNumber}</td>
              <td>{row.companyLogo ? <span className="actions"><CompanyIcon company={row.draft.company} logo={row.companyLogo} />{row.draft.company}</span>
                : row.draft.company}</td><td>{row.draft.role}</td>
              <td>{row.draft.url ? <a href={row.draft.url} target="_blank" rel="noreferrer">Open in this browser ↗</a> : row.url}</td>
              <td>{row.resumeName}</td>
              <td>{row.notes.length > 0 && <details><summary>{row.notes.length} {row.notes.length === 1 ? 'note' : 'notes'}</summary>
                <ol>{row.notes.map((text, index) => <li key={index}>{text}</li>)}</ol>
              </details>}</td>
              <td>{row.status}
                {(row.postingUnavailable || canReadLinkedIn(row)) && <div className="actions">
                  {canReadLinkedIn(row) && <button type="button"
                    disabled={reading || readingLinkedIn || saving || !!paste}
                    onClick={() => void readLinkedInRows([row], true)}>Read open tab</button>}
                  {row.postingUnavailable && <button type="button" disabled={reading || readingLinkedIn || saving || extracting}
                    onClick={() => setPaste({ row: row.row, text: '' })}>Paste posting text</button>}
                </div>}
                {row.draft.description && <details><summary>Preview details</summary>
                  <dl>{Object.entries({ Location: row.draft.location, Arrangement: row.draft.arrangement,
                    Salary: row.draft.salary, 'Date posted': row.draft.posted, Deadline: row.draft.deadline,
                    Requirements: row.draft.requirements, Description: row.draft.description }).map(([label, value]) =>
                    value && <div key={label}><dt>{label}</dt>
                      {label === 'Description' ? <dd className="rich-preview" dangerouslySetInnerHTML={{
                        __html: descriptionMarkup(value, row.draft.descriptionHtml),
                      }} /> : <dd>{value}</dd>}
                    </div>)}</dl>
                </details>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
        {paste && <section className="bulk-paste">
          <label>Posting text for row {paste.row}
            <textarea rows={5} maxLength={descriptionLimit} value={paste.text} disabled={extracting} autoFocus
              onChange={event => setPaste({ ...paste, text: event.target.value })} />
          </label>
          <small>Open the posting in this browser, then copy and paste the job description here.</small>
          <div className="actions">
            <button type="button" disabled={extracting || !paste.text.trim()}
              onClick={() => void applyPostingText()}>{extracting ? 'Reading…' : 'Use posting text'}</button>
            <button type="button" disabled={extracting} onClick={() => setPaste(null)}>Cancel</button>
          </div>
        </section>}
      </div>
      <footer className="dialog-foot">
        <button type="submit" className="primary" disabled={reading || readingLinkedIn || saving || !!paste || !ready.length}>
          {saving ? 'Importing…' : `Import ${ready.length} selected`}
        </button>
      </footer>
    </form>
  </dialog>
}

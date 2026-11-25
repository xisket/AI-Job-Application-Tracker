import { useEffect, useRef, useState } from 'react'
import { fillFieldLabels, findMissingDescriptionFields, isAiConfigured, missingDescriptionFields, saveJob, type FillValues } from './data'
import type { RecordItem } from './model'

type ReviewRow = { record: RecordItem; suggestions: FillValues; selected: boolean; status: string }

function makeRows(records: RecordItem[]): ReviewRow[] {
  return records.map(record => ({
    record, suggestions: {}, selected: false,
    status: !record.job.description.trim() ? 'No description' :
      missingDescriptionFields(record.job).length ? 'Ready to scan' : 'No missing fields',
  }))
}

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'

export function FillAiDialog({ records, onClose, onSaved }: {
  records: RecordItem[]
  onClose: () => void
  onSaved: (record: RecordItem) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const controller = useRef<AbortController | null>(null)
  const [rows, setRows] = useState(() => makeRows(records))
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState('')
  const [problem, setProblem] = useState('')
  const pending = rows.filter(row => Object.keys(row.suggestions).length > 0)
  const selected = pending.filter(row => row.selected)
  const busy = scanning || saving

  useEffect(() => {
    dialog.current?.showModal()
    return () => controller.current?.abort()
  }, [])

  function update(id: string, changes: Partial<ReviewRow>) {
    setRows(current => current.map(row => row.record.job.id === id ? { ...row, ...changes } : row))
  }

  async function scan() {
    const abort = new AbortController()
    controller.current = abort
    const { signal } = abort
    setScanning(true)
    setProblem('')
    setProgress('')
    try {
      if (!await isAiConfigured()) {
        if (!signal.aborted) setProblem('Choose an Ollama model in Settings before running a scan.')
        return
      }
      if (signal.aborted) return
      const initial = makeRows(records)
      setRows(initial)
      const candidates = initial.filter(row => row.status === 'Ready to scan')
      let completed = 0
      for (const { record: { job } } of candidates) {
        if (signal.aborted) break
        setProgress(`Checking ${completed + 1} of ${candidates.length} applications…`)
        update(job.id, { status: 'Reading description…' })
        try {
          const suggestions = await findMissingDescriptionFields(job, signal)
          if (signal.aborted) {
            update(job.id, { status: 'Canceled' })
            break
          }
          const count = Object.keys(suggestions).length
          update(job.id, { suggestions, selected: count > 0, status: count ? 'Ready to review' : 'No matching values found' })
        } catch (error) {
          update(job.id, { status: signal.aborted ? 'Canceled' : errorText(error) })
          if (signal.aborted) break
        }
        completed++
      }
      setProgress(signal.aborted ? `Scan canceled after checking ${completed} of ${candidates.length} applications.`
        : `Checked ${completed} ${completed === 1 ? 'application' : 'applications'}.`)
    } finally {
      setScanning(false)
    }
  }

  async function apply() {
    setSaving(true)
    setProgress('')
    setProblem('')
    let saved = 0
    for (const row of selected) {
      try {
        const { job, etag } = row.record
        if (!etag) throw new Error('Refresh the application list before applying suggestions.')
        const record = await saveJob({ ...job, ...row.suggestions, updated: new Date().toISOString() }, etag)
        onSaved(record)
        update(job.id, { record, suggestions: {}, selected: false, status: 'Saved' })
        saved++
      } catch (error) {
        update(row.record.job.id, { status: errorText(error) })
      }
    }
    setProgress(`Saved suggestions for ${saved} of ${selected.length} selected applications.`)
    setSaving(false)
  }

  return <dialog className="bulk-import" ref={dialog} aria-labelledby="fill-ai-title" onCancel={event => {
    event.preventDefault()
    if (!saving) onClose()
  }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy && selected.length) void apply() }}>
      <header className="dialog-head">
        <h2 id="fill-ai-title">Fill with AI</h2>
        <button type="button" onClick={onClose} disabled={saving}>Close</button>
      </header>
      <div className="dialog-content bulk-content">
        <p>Check saved job descriptions for missing details, then review the suggestions before saving.</p>
        <div className="actions">
          <button type="button" disabled={busy || !records.some(({ job }) => job.description.trim() && missingDescriptionFields(job).length)}
            onClick={() => void scan()}>Scan applications</button>
          {scanning && <button type="button" onClick={() => controller.current?.abort()}>Cancel scan</button>}
        </div>
        {problem && <p role="alert" className="notice">{problem}</p>}
        {progress && <p role="status">{progress}</p>}
        {rows.length ? <div className="bulk-grid fill-ai-grid" tabIndex={0} role="region" aria-label="AI suggestions">
          <table>
            <thead><tr>
              <th scope="col"><input type="checkbox" aria-label="Select all suggestions"
                disabled={busy || !pending.length}
                checked={pending.length > 0 && selected.length === pending.length}
                onChange={event => {
                  const checked = event.target.checked
                  setRows(current => current.map(row => ({ ...row, selected: checked && Object.keys(row.suggestions).length > 0 })))
                }} /></th>
              <th scope="col">Application</th><th scope="col">Missing fields</th><th scope="col">Suggested values</th><th scope="col">Status</th>
            </tr></thead>
            <tbody>{rows.map(({ record: { job }, suggestions, selected, status }) => <tr key={job.id}>
              <td><input type="checkbox" aria-label={`Apply suggestions for ${job.role} at ${job.company}`}
                disabled={busy || !Object.keys(suggestions).length} checked={selected}
                onChange={event => update(job.id, { selected: event.target.checked })} /></td>
              <td><strong>{job.role || 'Untitled application'}</strong><br />{job.company}</td>
              <td>{missingDescriptionFields(job).map(key => fillFieldLabels[key]).join(', ') || '—'}</td>
              <td>{Object.keys(suggestions).length ? <dl>{Object.entries(suggestions).map(([key, value]) =>
                <div key={key}><dt>{fillFieldLabels[key as keyof FillValues]}</dt><dd>{value}</dd></div>)}</dl> : '—'}</td>
              <td>{status}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p>No saved applications.</p>}
      </div>
      <footer className="dialog-foot">
        <button type="submit" className="primary" disabled={busy || !selected.length}>
          {saving ? 'Saving…' : `Apply selected (${selected.length})`}
        </button>
      </footer>
    </form>
  </dialog>
}

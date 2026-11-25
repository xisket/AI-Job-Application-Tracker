import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { deleteJob, descriptionLimit, fetchPosting, isAiConfigured, loadJobs, parsePosting, saveJob, searchPositions, sharePosition, type SearchResult } from './data'
import { downloadFile, positionDetails, positionFilename, positionHtml, positionPdf } from './position'
import { Calendar, TodayView } from './schedule'
import { SettingsDialog } from './settings'
import { BulkImportDialog } from './bulk-import'
import { FillAiDialog } from './fill-ai'
import { NotesPanel, type NoteDraft } from './notes'
import { RichDescription } from './rich-description'
import { descriptionMarkup } from './description-html'
import { CompanyIcon, CompanyLogoEditor, companyLogoSource } from './company-logo'
import { compareApplications, type ApplicationSort } from './application-sort'
import { addDays, applicationNotes, blank, closed, extractedFields, positionDate, reminders, safeUrl, stages, today, type Draft, type Entry, type JobWrite, type RecordItem, type Reminder } from './model'
import './style.css'

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const showDate = (date: string) => date ? dates.format(new Date(date.length === 10 ? date + 'T12:00:00' : date)) : ''
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'
const event = (kind: string, text: string): Entry => ({ id: crypto.randomUUID(), date: new Date().toISOString(), kind, text })

function PositionPreview({ position }: { position: Draft }) {
  const { title, company, facts, sections, url } = positionDetails(position)
  return <article className="position-preview">
    <h2>{title}</h2>
    {company && <p>{company}</p>}
    <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {url && <a className="preview-link" href={url} target="_blank" rel="noopener noreferrer">View original posting</a>}
    {sections.map(([label, value]) => <section key={label}><h3>{label}</h3>
      {label === 'Job description' ? <div className="rich-preview"
        dangerouslySetInnerHTML={{ __html: descriptionMarkup(value, position.descriptionHtml) }} /> : <p>{value}</p>}
    </section>)}
  </article>
}

function Editor({ record, onClose, onSaved, onDeleted }: { record?: RecordItem; onClose: () => void; onSaved: (item: RecordItem) => void; onDeleted: (id: string) => void }) {
  const job = record?.job
  const [draft, setDraft] = useState<Draft>(() => {
    const initial = { ...blank }
    if (job) for (const key of Object.keys(blank) as (keyof Draft)[]) {
      Object.assign(initial, { [key]: job[key] ?? blank[key] })
    }
    return initial
  })
  const [mode, setMode] = useState<'link' | 'paste' | 'manual'>('link')
  const [logoUpdate, setLogoUpdate] = useState<string>()
  const [importedLogo, setImportedLogo] = useState<{ company: string; source: string }>()
  const [tab, setTab] = useState<'details' | 'notes'>('details')
  const [notes, setNotes] = useState(() => job ? applicationNotes(job) : [])
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [preview, setPreview] = useState(false)
  const [activity, setActivity] = useState('')
  const [kind, setKind] = useState('Note')
  const dialog = useRef<HTMLDialogElement>(null)
  const roleInput = useRef<HTMLInputElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const keepEditingButton = useRef<HTMLButtonElement>(null)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(existing => ({ ...existing, [key]: value }))
  const position = { ...draft, notes: notes.map(note => note.text).join('\n\n') }
  const companyKey = draft.company.trim().toUpperCase()
  const importedLogoSource = importedLogo?.company === companyKey ? importedLogo.source : ''
  const savedLogo = job?.company.trim().toUpperCase() === companyKey ? job.companyLogo ?? '' : ''
  const originalNotes = job ? applicationNotes(job) : []
  const pendingNoteChanged = noteDraft !== null && noteDraft.text.trim() !==
    (notes.find(note => note.id === noteDraft.id)?.text.trim() ?? '')
  const hasChanges = (Object.keys(blank) as (keyof Draft)[]).some(key => draft[key] !== (job?.[key] ?? blank[key])) ||
    Boolean(activity.trim()) || (logoUpdate !== undefined && logoUpdate !== (savedLogo || importedLogoSource)) ||
    notes.length !== originalNotes.length || notes.some((note, index) =>
      note.id !== originalNotes[index]?.id || note.text !== originalNotes[index]?.text) || pendingNoteChanged

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { if (confirmClose) keepEditingButton.current?.focus() }, [confirmClose])

  function requestClose() {
    if (busy) return
    if (!hasChanges) {
      onClose()
      return
    }
    setConfirmDelete(false)
    setConfirmClose(true)
  }

  function keepEditing() {
    setConfirmClose(false)
    closeButton.current?.focus()
  }

  async function importJob() {
    setBusy(true)
    setNotice('')
    try {
      let text = draft.description
      let truncated = false
      let linkFields: Partial<Draft> | undefined
      if (mode === 'link') {
        const posting = await fetchPosting(draft.url.trim())
        text = posting.text.slice(0, descriptionLimit)
        truncated = Boolean(posting.truncated)
        linkFields = 'fields' in posting ? posting.fields : undefined
        if (posting.logo && posting.fields.company) setImportedLogo({ company: posting.fields.company.trim().toUpperCase(), source: posting.logo })
        setDraft(existing => ({ ...existing, description: text, descriptionHtml: posting.html }))
      }
      const fields = linkFields ?? await parsePosting(text)
      setDraft(existing => ({ ...existing, ...fields }))
      setMode('manual')
      setNotice(truncated ? 'The importer returned part of the posting. Check the extracted fields and source text before saving.' : 'Review the extracted fields before saving.')
    } catch (error) {
      setNotice(errorText(error))
      if (mode === 'link') setMode('paste')
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy || confirmClose || confirmDelete) return
    if (pendingNoteChanged) {
      setTab('notes')
      setNotice('Finish or cancel the note before saving the application.')
      return
    }
    void saveApplication(notes)
  }

  async function saveApplication(nextNotes: typeof notes) {
    const role = draft.role.trim()
    const company = draft.company.trim()
    const url = safeUrl(draft.url.trim())
    if (!role || !company || (draft.url.trim() && !url)) {
      setTab('details')
      setPreview(false)
      setNotice('Enter a role, company, and a valid posting URL if you have one.')
      return
    }
    const logo = logoUpdate?.trim()
    if (logo && !companyLogoSource(logo)) {
      setTab('details')
      setPreview(false)
      setNotice('Enter a valid HTTP or HTTPS company logo URL, or upload an image.')
      return
    }
    setBusy(true)
    setNotice('')
    const history = [...(job?.history ?? [])]
    if (!job) history.push(event('Added', 'Added as ' + draft.stage))
    else if (draft.stage !== job.stage) history.push(event('Status', job.stage + ' to ' + draft.stage))
    if (activity.trim()) history.push(event(kind, activity.trim()))
    const reminderState = { ...job?.reminders }
    if (job?.due !== draft.due || job?.next !== draft.next) delete reminderState['Follow-up:' + draft.due]
    if (job?.interview !== draft.interview) delete reminderState['Interview:' + draft.interview]
    if (job?.deadline !== draft.deadline) delete reminderState['Application deadline:' + draft.deadline]
    const updated: JobWrite = {
      reminders: reminderState,
      created: job?.created ?? job?.history.find(item => item.kind === 'Added')?.date ?? job?.history[0]?.date ?? job?.updated ?? new Date().toISOString(),
      ...draft, role, company, url, history, notes: '', noteEntries: nextNotes,
      ...(logo !== undefined && logo !== (savedLogo || importedLogoSource) ? { companyLogoUpdate: logo } : {}),
      ...(importedLogoSource && !savedLogo ? { companyLogoImport: importedLogoSource } : {}),
      id: job?.id ?? crypto.randomUUID(), updated: new Date().toISOString(),
    }
    try {
      onSaved(await saveJob(updated, record?.etag))
    } catch (error) {
      setNotice(errorText(error))
      setBusy(false)
    }
  }

  function notesWithDraft(draft: NoteDraft) {
    const text = draft.text.trim()
    const stamp = new Date().toISOString()
    if (draft.id) {
      return notes.map(note => note.id === draft.id && note.text !== text
        ? { ...note, text, updated: stamp }
        : note)
    }
    return [...notes, { id: crypto.randomUUID(), text, created: stamp, updated: stamp }]
  }

  function saveNote() {
    if (!noteDraft?.text.trim()) return
    setNotes(notesWithDraft(noteDraft))
    setNoteDraft(null)
    setNotice('')
  }

  function saveAndClose() {
    setConfirmClose(false)
    if (pendingNoteChanged && noteDraft) {
      if (!noteDraft.text.trim()) {
        setTab('notes')
        setNotice('Enter note text or cancel the note edit before saving.')
        return
      }
      void saveApplication(notesWithDraft(noteDraft))
      return
    }
    void saveApplication(notes)
  }

  const fields: { key: keyof Omit<Draft, 'stage'>; label: string; type?: string; max?: number; required?: boolean }[] = [
    { key: 'role', label: 'Job title', required: true, max: extractedFields.role },
    { key: 'company', label: 'Company', required: true, max: extractedFields.company },
    { key: 'location', label: 'Location', max: extractedFields.location },
    { key: 'arrangement', label: 'Work arrangement', max: extractedFields.arrangement },
    { key: 'salary', label: 'Salary range', max: extractedFields.salary },
    { key: 'deadline', label: 'Application deadline', type: 'date' },
    { key: 'url', label: 'Posting URL', max: 2000 },
    { key: 'posted', label: 'Date posted', type: 'date' },
    { key: 'applied', label: 'Date applied', type: 'date' },
    { key: 'interview', label: 'Interview date', type: 'date' },
    { key: 'next', label: 'Next action', max: 250 },
    { key: 'due', label: 'Follow-up due', type: 'date' },
  ]

  async function removePosition() {
    if (!record || busy) return
    setBusy(true)
    setNotice('')
    try {
      await deleteJob(record)
      onDeleted(record.job.id)
    } catch (error) {
      setNotice(errorText(error))
      setBusy(false)
    }
  }

  async function exportPosition(kind: 'html' | 'pdf' | 'share') {
    setBusy(true)
    setNotice('')
    try {
      if (kind === 'share') setNotice(await sharePosition(position))
      else {
        const file = kind === 'html' ? new Blob([positionHtml(position)], { type: 'text/html;charset=utf-8' }) : await positionPdf(position)
        const name = positionFilename(draft) + '.' + kind
        downloadFile(file, name)
      }
    } catch (error) {
      setNotice(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialog} aria-labelledby={confirmClose ? 'unsaved-title' : 'editor-title'} onCancel={e => {
    e.preventDefault()
    if (busy) return
    if (confirmClose) keepEditing()
    else if (confirmDelete) setConfirmDelete(false)
    else requestClose()
  }}>
    <form onSubmit={submit} noValidate>
      <header className="dialog-head">
        <h2 id="editor-title">{job ? 'Application details' : 'Add application'}</h2>
        <button ref={closeButton} type="button" className="icon" aria-label="Close"
          onClick={confirmClose ? keepEditing : requestClose} disabled={busy}>×</button>
      </header>
      <div className="dialog-content">
        {confirmClose && <section className="delete-confirm" aria-labelledby="unsaved-title">
          <h3 id="unsaved-title">Save changes before closing?</h3>
          <p>You have unsaved changes to this application.</p>
        </section>}
        {!confirmClose && !confirmDelete && <div className="segments editor-tabs" role="tablist" aria-label="Application">
          {(['details', 'notes'] as const).map((name, index) => <button key={name} type="button" role="tab"
            id={`application-tab-${name}`} aria-controls={`application-panel-${name}`} aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1} disabled={busy} onClick={() => setTab(name)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 'details' : event.key === 'End' ? 'notes' : index === 0 ? 'notes' : 'details'
              setTab(next)
              document.getElementById(`application-tab-${next}`)?.focus()
            }}>{name === 'details' ? 'Details' : 'Notes'}</button>)}
        </div>}
        {!confirmClose && notice && <p className="notice" role="status">{notice}</p>}
        {!confirmClose && confirmDelete && <section className="delete-confirm" aria-labelledby="delete-title">
          <h3 id="delete-title">Delete this posting?</h3>
          <p>The posting, notes, activity, and reminders will be permanently removed.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep posting</button>
            <button type="button" className="danger" disabled={busy} onClick={() => void removePosition()}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </section>}
        <section role="tabpanel" id="application-panel-details" aria-labelledby="application-tab-details"
          hidden={tab !== 'details' || confirmDelete || confirmClose}>
          <div className="actions position-tools" aria-label="Position tools">
            <button type="button" aria-pressed={preview} disabled={busy} onClick={() => setPreview(value => !value)}>{preview ? 'Back to form' : 'Preview'}</button>
            <button type="button" disabled={busy} onClick={() => void exportPosition('html')}>Export HTML</button>
            <button type="button" disabled={busy} onClick={() => void exportPosition('pdf')}>Export PDF</button>
            <button type="button" disabled={busy} onClick={() => void exportPosition('share')}>Share</button>
          </div>
          {preview && <PositionPreview position={position} />}
          <fieldset disabled={busy} className={preview ? 'editor-hidden' : undefined}>
            {!job && <section className="import">
              <div className="segments" aria-label="Add method">
                {(['link', 'paste', 'manual'] as const).map(option => <button type="button" key={option} aria-pressed={mode === option} onClick={() => {
                  setMode(option)
                  setNotice('')
                  if (option === 'manual') roleInput.current?.focus()
                }}>{({ link: 'Import link', paste: 'Paste description', manual: 'Enter manually' })[option]}</button>)}
              </div>
              {mode === 'link' && <input aria-label="URL to import" placeholder="https://company.com/jobs/role" value={draft.url} maxLength={2000} onChange={e => set('url', e.target.value)} />}
              {mode === 'paste' && <textarea aria-label="Job description to extract" placeholder="Paste the job description here" rows={4} maxLength={descriptionLimit} value={draft.description} onChange={e => setDraft(existing => ({ ...existing, description: e.target.value, descriptionHtml: '' }))} />}
              {mode !== 'manual' && <button type="button" onClick={importJob} className="secondary">{busy ? 'Reading posting...' : 'Extract job details'}</button>}
            </section>}

            <div className="form-grid">
              {fields.map(({ key, label, type, max, required }) => {
                const field = <label key={key}>{label}<input ref={key === 'role' ? roleInput : undefined} name={key} type={type ?? 'text'} required={required} maxLength={max}
                  value={key === 'applied' ? draft.applied.slice(0, 10) : draft[key]} onChange={e => {
                    const value = e.target.value
                    set(key, key === 'applied' && value ? value + draft.applied.slice(10) : value)
                  }} /></label>
                if (key !== 'company') return field
                return <div key={key} className="company-field">
                  <CompanyLogoEditor company={draft.company} logo={logoUpdate ?? (savedLogo || importedLogoSource)} onChange={setLogoUpdate} />
                  {field}
                </div>
              })}
              <label>Time applied<input type="time" step="1" disabled={!draft.applied}
                value={draft.applied.slice(11, 19)} onChange={e => {
                  const date = draft.applied.slice(0, 10)
                  const time = e.target.value
                  set('applied', time ? date + 'T' + (time.length === 5 ? time + ':00' : time) + draft.applied.slice(19) : date)
                }} /></label>
              <label>Status<select aria-label="Status" value={draft.stage} onChange={e => {
                const stage = e.target.value as Draft['stage']
                setDraft(current => ({ ...current, stage, applied: stage === 'Applied' && !current.applied ? today() : current.applied }))
              }}>{stages.map(stage => <option key={stage}>{stage}</option>)}</select></label>
            </div>
            <label>Requirements<textarea rows={3} maxLength={extractedFields.requirements} value={draft.requirements} onChange={e => set('requirements', e.target.value)} /></label>
            <details><summary>Job description</summary>
              <RichDescription text={draft.description} html={draft.descriptionHtml} disabled={busy}
                onChange={(description, descriptionHtml) => setDraft(existing => ({ ...existing, description, descriptionHtml }))} />
            </details>
            {job && <section className="history">
              <h3>Activity</h3>
              <div className="form-grid">
                <label>Activity type<select aria-label="Activity type" value={kind} onChange={e => setKind(e.target.value)}><option>Note</option><option>Interview</option><option>Follow-up</option></select></label>
                <label>New activity<input value={activity} maxLength={1000} onChange={e => setActivity(e.target.value)} placeholder="Add an update" /></label>
              </div>
              <ol>{[...job.history].reverse().map(item => <li key={item.id}><span>{item.kind} · {showDate(item.date)}</span><p>{item.text}</p></li>)}</ol>
            </section>}
          </fieldset>
        </section>
        <section role="tabpanel" id="application-panel-notes" aria-labelledby="application-tab-notes"
          hidden={tab !== 'notes' || confirmDelete || confirmClose}>
          <NotesPanel notes={notes} draft={noteDraft} busy={busy} onEdit={setNoteDraft} onSave={saveNote}
            onDelete={id => setNotes(existing => existing.filter(note => note.id !== id))} />
        </section>
      </div>
      <footer className="dialog-foot">
        {confirmClose ? <>
          <button type="button" className="secondary" ref={keepEditingButton} onClick={keepEditing}>Keep editing</button>
          <button type="button" className="danger" onClick={onClose}>Discard changes</button>
          <button type="button" className="primary" onClick={saveAndClose}>Save changes</button>
        </> : <>
          {record && !confirmDelete && <button type="button" className="danger delete-trigger" disabled={busy} onClick={() => {
            setNotice('')
            setConfirmDelete(true)
          }}>Delete posting</button>}
          <button type="button" className="secondary" disabled={busy} onClick={requestClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (tab === 'details' && preview) || confirmDelete}>Save application</button>
        </>}
      </footer>
    </form>
  </dialog>
}

function App() {
  const [records, setRecords] = useState<RecordItem[]>([])
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState('All stages')
  const [sort, setSort] = useState<ApplicationSort>('default')
  const [view, setView] = useState('All applications')
  const [year, setYear] = useState('')
  const [from, setFrom] = useState('')
  const [question, setQuestion] = useState('')
  const [answers, setAnswers] = useState<SearchResult | null>(null)
  const [aiConfigured, setAiConfigured] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [fillAiOpen, setFillAiOpen] = useState(false)
  useEffect(() => { void isAiConfigured().then(setAiConfigured) }, [])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [reminderBusy, setReminderBusy] = useState(false)
  const [editor, setEditor] = useState<{ record?: RecordItem } | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState('')
  const [selectedJobs, setSelectedJobs] = useState<Set<string> | null>(null)
  const [deletingJobs, setDeletingJobs] = useState(false)
  const [deleteNotice, setDeleteNotice] = useState('')
  const refresh = useCallback(() => {
    setLoading(true)
    setProblem('')
    void loadJobs().then(setRecords).catch(error => setProblem(errorText(error))).finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const date = today()
  const jobs = records.map(item => item.job)
  const active = jobs.filter(job => !closed(job.stage))
  const tasks = reminders(records)
  const due = tasks.filter(task => task.type === 'Follow-up' && task.date <= date)
  const followUpDates = new Map(tasks.filter(task => task.type === 'Follow-up').map(task => [task.record.job.id, task.date]))
  const years = [...new Set(jobs.map(job => positionDate(job).slice(0, 4)).filter(Boolean))].sort().reverse()
  const visible = records.filter(({ job }) => {
    const day = positionDate(job)
    if (view !== 'Calendar' && year && !day.startsWith(year + '-')) return false
    if (from && day < from) return false
    if (view === 'Follow-ups' && (closed(job.stage) || (!job.due && !job.next))) return false
    if (view === 'Closed' && !closed(job.stage)) return false
    if (stage !== 'All stages' && job.stage !== stage) return false
    return [job.role, job.company, job.location, job.next].join(' ').toLowerCase().includes(query.trim().toLowerCase())
  }).sort((a, b) => {
    const updated = b.job.updated.localeCompare(a.job.updated)
    if (sort !== 'default') return compareApplications(a.job, b.job, sort) || updated
    return view === 'Follow-ups'
      ? (followUpDates.get(a.job.id) || '9999').localeCompare(followUpDates.get(b.job.id) || '9999') || updated
      : updated
  })
  const isListView = view !== 'Today' && view !== 'Calendar'
  const selectedVisible = visible.filter(({ job }) => selectedJobs?.has(job.id))

  async function deleteSelected() {
    const count = selectedVisible.length
    if (deletingJobs || !count || !window.confirm(`Permanently delete ${count} selected ${count === 1 ? 'application' : 'applications'} and their notes?`)) return
    setDeletingJobs(true)
    setDeleteNotice('')
    setProblem('')
    const removed = new Set<string>()
    let failure = ''
    for (const item of selectedVisible) {
      try {
        await deleteJob(item)
        removed.add(item.job.id)
      } catch (error) {
        failure ||= errorText(error)
      }
    }
    setRecords(existing => existing.filter(({ job }) => !removed.has(job.id)))
    setAnswers(null)
    setSelectedJobs(failure ? new Set(selectedVisible.filter(({ job }) => !removed.has(job.id)).map(({ job }) => job.id)) : null)
    setDeleteNotice(`${removed.size} deleted.`)
    if (failure) setProblem(`${count - removed.size} could not be deleted. ${failure}`)
    setDeletingJobs(false)
  }

  const openPosition = (record: RecordItem) => setEditor({ record })
  const updateRecord = (item: RecordItem) => {
    setRecords(existing => [item, ...existing.filter(previous => previous.job.id !== item.job.id).map(previous =>
      item.job.companyId && previous.job.companyId === item.job.companyId
        ? { ...previous, job: { ...previous.job, companyLogo: item.job.companyLogo } }
        : previous)])
    setAnswers(null)
  }

  async function ask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!question.trim() || aiBusy) return
    setAiBusy(true)
    setAiError('')
    setAnswers(null)
    try {
      setAnswers(await searchPositions(question.trim(), records))
    } catch (error) {
      setAiError(errorText(error))
    } finally {
      setAiBusy(false)
    }
  }

  async function changeReminder(task: Reminder, action: 'done' | 'snooze') {
    setReminderBusy(true)
    setProblem('')
    const { job, etag } = task.record
    const snoozed = addDays(task.date < date ? date : task.date, 1)
    try {
      updateRecord(await saveJob({
        ...job,
        next: action === 'done' && task.type === 'Follow-up' ? '' : job.next,
        due: action === 'done' && task.type === 'Follow-up' ? '' : job.due,
        reminders: { ...job.reminders, [task.key]: action === 'done' ? { done: true } : { snoozed } },
        history: [...job.history, event('Reminder', action === 'done' ? task.title + ' completed' : task.title + ' snoozed to ' + snoozed)],
        updated: new Date().toISOString(),
      }, etag))
    } catch (error) {
      setProblem(errorText(error))
    } finally {
      setReminderBusy(false)
    }
  }

  return <main>
    <header className="masthead">
      <div className="brand"><span className="mark" aria-hidden="true">↗</span> AI Job Application Tracker</div>
      <div className="actions">
        <button onClick={() => setSettingsOpen(true)}>Settings</button>
        <button onClick={() => setImportOpen(true)} disabled={loading}>Import spreadsheet</button>
        <button onClick={() => setFillAiOpen(true)} disabled={loading}>Fill with AI</button>
        <button className="primary" onClick={() => setEditor({})}>+ Add application</button>
      </div>
    </header>
    <section className="hero">
      <h1>Your job search</h1>
      <p>Track applications, interviews, and what comes next.</p>
    </section>
    <section className="stats" aria-label="Application totals">
      <article><span>Active applications</span><strong>{active.length}</strong></article>
      <article><span>Interviewing</span><strong>{jobs.filter(job => job.stage === 'Interviewing').length}</strong></article>
      <article><span>Follow-ups due</span><strong>{due.length}</strong></article>
    </section>
    <section className="ask-panel" aria-label="Search applications with AI">
      <form onSubmit={ask}>
        <label htmlFor="position-question">{aiConfigured ? 'Ask AI about your applications' : 'Ask about your applications'}</label>
        <div className="actions">
          <input id="position-question" type="search" placeholder="What should I do today?" value={question} maxLength={300}
            onChange={e => setQuestion(e.target.value)} />
          <button className="primary" type="submit" disabled={aiBusy || loading || !question.trim()}>{aiBusy ? 'Searching…' : 'Ask'}</button>
        </div>
      </form>
      {!aiConfigured && <small>AI search is off. <button type="button" className="text-button" onClick={() => setSettingsOpen(true)}>Choose an Ollama model</button></small>}
      {aiError && <p role="alert" className="notice">{aiError}</p>}
      {answers && <section aria-label="Search results" className="ask-results">
        <div className="task-header"><h2>{Array.isArray(answers) ? 'Matches' : 'Application total'}</h2><button onClick={() => setAnswers(null)}>Clear results</button></div>
        {!Array.isArray(answers) && <p>{answers.count} saved {answers.count === 1 ? 'application' : 'applications'}.</p>}
        {Array.isArray(answers) && !answers.length && <p>No applications match this question.</p>}
        {Array.isArray(answers) && answers.length > 0 && <ul>{answers.map(answer => {
          const item = records.find(record => record.job.id === answer.id)
          return item && <li key={answer.id}><button className="text-button" onClick={() => openPosition(item)}>{item.job.role} · {item.job.company}</button><p>{answer.reason}</p></li>
        })}</ul>}
      </section>}
    </section>
    <section className="workspace" aria-label="Applications">
      <div className="toolbar">
        <div className="segments views" aria-label="Application view">
          {['All applications', 'Today', 'Calendar', 'Follow-ups', 'Closed'].map(option => <button key={option} aria-pressed={view === option} onClick={() => { setView(option); setStage('All stages') }}>{option}</button>)}
        </div>
        {view !== 'Today' && <div className="filters">
          <label>{view === 'Calendar' ? 'Go to year' : 'Year'}
            <select value={year} onChange={e => setYear(e.target.value)}><option value="">{view === 'Calendar' ? 'Choose year' : 'All years'}</option>{years.map(option => <option key={option}>{option}</option>)}</select>
          </label>
          <label>From date<input aria-label="From date" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <input type="search" aria-label="Search applications" placeholder="Search applications" value={query} onChange={e => setQuery(e.target.value)} />
          <select aria-label="Filter by status" value={stage} onChange={e => setStage(e.target.value)}><option>All stages</option>{stages.map(option => <option key={option}>{option}</option>)}</select>
          {isListView && <label>Sort by<select value={sort} onChange={e => setSort(e.target.value as ApplicationSort)}>
            <option value="default">{view === 'Follow-ups' ? 'Follow-up date' : 'Recently updated'}</option>
            <option value="salary-asc">Salary · Low to high</option>
            <option value="salary-desc">Salary · High to low</option>
            <option value="applied-asc">Date applied · Oldest first</option>
            <option value="applied-desc">Date applied · Newest first</option>
            <option value="company-asc">Company · A to Z</option>
            <option value="company-desc">Company · Z to A</option>
          </select></label>}
          <button className="secondary" aria-label="Refresh applications" title="Refresh applications" disabled={loading || deletingJobs} onClick={refresh}>↻</button>
        </div>}
      </div>
      {isListView && !loading && visible.length > 0 && <div className="actions bulk-delete-tools">
        {selectedJobs ? <>
          <button disabled={deletingJobs} onClick={() => setSelectedJobs(new Set(visible.map(({ job }) => job.id)))}>Select all visible</button>
          <button className="danger" disabled={deletingJobs || !selectedVisible.length} onClick={() => void deleteSelected()}>
            {deletingJobs ? 'Deleting…' : `Delete selected (${selectedVisible.length})`}
          </button>
          <button disabled={deletingJobs} onClick={() => setSelectedJobs(null)}>Cancel selection</button>
        </> : <button onClick={() => { setDeleteNotice(''); setSelectedJobs(new Set()) }}>Select applications</button>}
      </div>}
      {deleteNotice && <p role="status" className="notice">{deleteNotice}</p>}
      {problem && <p role="alert" className="notice">{problem}</p>}
      {loading && <p className="empty" role="status">Loading applications...</p>}
      {!loading && view === 'Today' && <TodayView tasks={tasks} onOpen={openPosition} onChange={changeReminder} busy={reminderBusy} />}
      {!loading && view === 'Calendar' && <Calendar records={visible} year={year} from={from} onOpen={openPosition} />}
      {!loading && !problem && view !== 'Today' && view !== 'Calendar' && !visible.length && <div className="empty">
        <h2>{jobs.length ? 'No applications in this view' : 'Start with a job posting'}</h2>
        <p>{jobs.length ? 'Try a different search or filter.' : 'Import a link, paste a description, or enter the details yourself.'}</p>
        {!jobs.length && <button className="secondary" onClick={() => setEditor({})}>Add your first application</button>}
      </div>}
      {view !== 'Today' && view !== 'Calendar' && visible.length > 0 && <ul className="applications">{visible.map(item => {
        const { job } = item
        const followUp = followUpDates.get(job.id)
        return <li key={job.id}>
          <div className="bulk-row">
          {selectedJobs && <input type="checkbox" aria-label={`Select ${job.role} at ${job.company}`} checked={selectedJobs.has(job.id)}
            disabled={deletingJobs} onChange={e => {
              const selection = new Set(selectedJobs)
              if (e.target.checked) selection.add(job.id)
              else selection.delete(job.id)
              setSelectedJobs(selection)
            }} />}
          <button className="job" disabled={deletingJobs} onClick={() => setEditor({ record: item })}>
            <CompanyIcon company={job.company} logo={job.companyLogo} />
            <span className="identity">
              <strong>{job.role}</strong><small>{[job.company, job.location].filter(Boolean).join(' · ')}</small>
              <span className="application-facts">
                <small>Salary {job.salary || '—'}</small>
                <small>Applied {job.applied ? showDate(job.applied.slice(0, 10)) : '—'}</small>
              </span>
            </span>
            <span className="pill" data-stage={job.stage}>{job.stage}</span>
            <span className="next"><span>{job.next || (followUp ? 'Follow up' : '—')}</span>{followUp && <small className={followUp <= date ? 'due' : ''}>{showDate(followUp)}</small>}</span>
            <span className="arrow" aria-hidden="true">›</span>
          </button>
          </div>
          {job.url && safeUrl(job.url) && <a className="posting" href={job.url} target="_blank" rel="noopener noreferrer">Open posting ↗</a>}
        </li>
      })}</ul>}
    </section>
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={setAiConfigured} />}
    {importOpen && <BulkImportDialog records={records} onClose={() => setImportOpen(false)} onSaved={updateRecord} />}
    {fillAiOpen && <FillAiDialog records={records} onClose={() => setFillAiOpen(false)} onSaved={updateRecord} />}
    {editor && <Editor record={editor.record} onClose={() => setEditor(null)} onDeleted={id => {
      setRecords(existing => existing.filter(item => item.job.id !== id))
      setAnswers(null)
      setEditor(null)
    }} onSaved={item => {
      updateRecord(item)
      setEditor(null)
    }} />}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)










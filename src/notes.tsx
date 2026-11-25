import type { ApplicationNote } from './model'

const noteDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function NoteDate({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{noteDate.format(new Date(value))}</time> : 'Unknown'
}

export type NoteDraft = { id?: string; text: string }

export function NotesPanel({ notes, draft, busy, onEdit, onSave, onDelete }: {
  notes: ApplicationNote[]
  draft: NoteDraft | null
  busy: boolean
  onEdit: (draft: NoteDraft | null) => void
  onSave: () => void
  onDelete: (id: string) => void
}) {
  return <fieldset disabled={busy} className="application-notes">
    <small>Use Save application to keep changes to your notes.</small>
    {draft ? <div className="note-composer">
      <label>{draft.id ? 'Edit note' : 'New note'}
        <textarea rows={4} maxLength={5000} value={draft.text} autoFocus
          onChange={event => onEdit({ ...draft, text: event.target.value })} />
      </label>
      <div className="actions">
        <button type="button" className="note-icon" aria-label={draft.id ? 'Update note' : 'Add note'} title={draft.id ? 'Update note' : 'Add note'}
          disabled={!draft.text.trim()} onClick={onSave}>✓</button>
        <button type="button" className="note-icon" aria-label="Cancel note" title="Cancel note" onClick={() => onEdit(null)}>×</button>
      </div>
    </div> : <div><button type="button" className="note-icon" aria-label="New note" title="New note" onClick={() => onEdit({ text: '' })}>+</button></div>}
    {notes.length === 0 ? <p>No notes yet.</p> : <ul className="note-list">
      {notes.map((note, index) => <li key={note.id}>
        <p>{note.text}</p>
        <div className="actions">
          <button type="button" className="note-icon note-action" disabled={draft !== null} aria-label={`Edit note ${index + 1}`} title="Edit note"
            onClick={() => onEdit({ id: note.id, text: note.text })}>✎</button>
          <button type="button" className="note-icon note-action danger" disabled={draft !== null} aria-label={`Delete note ${index + 1}`} title="Delete note"
            onClick={() => onDelete(note.id)}>×</button>
          <span className="note-info note-action">
            <button type="button" className="note-icon" aria-label={`Dates for note ${index + 1}`} aria-describedby={`note-dates-${note.id}`}
              onClick={event => event.currentTarget.focus()}>i</button>
            <small className="note-dates" role="tooltip" id={`note-dates-${note.id}`}>
              <span>Created <NoteDate value={note.created} /></span>
              <span>Updated <NoteDate value={note.updated} /></span>
            </small>
          </span>
        </div>
      </li>)}
    </ul>}
  </fieldset>
}

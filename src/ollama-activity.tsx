import { useEffect, useRef, useState } from 'react'
import { loadOllamaActivity, loadOllamaActivityDetail, type OllamaActivity, type OllamaActivityDetail } from './data'

const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

function modelReply(response: string | null) {
  if (!response) return ''
  try {
    const content = JSON.parse(response)?.message?.content
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

export function OllamaActivityDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [entries, setEntries] = useState<OllamaActivity[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [detail, setDetail] = useState<OllamaActivityDetail>()
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [problem, setProblem] = useState('')

  async function load(cursor?: number) {
    setLoading(true)
    setProblem('')
    try {
      const page = await loadOllamaActivity(cursor)
      setEntries(current => cursor === undefined ? page.entries : [...current, ...page.entries])
      setBefore(page.nextBefore)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not load Ollama activity.')
    } finally {
      setLoading(false)
    }
  }

  async function open(id: number) {
    setOpening(true)
    setProblem('')
    try {
      setDetail(await loadOllamaActivityDetail(id))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not load this request.')
    } finally {
      setOpening(false)
    }
  }

  useEffect(() => {
    const popup = dialog.current
    popup?.showModal()
    void load()
    return () => popup?.close()
  }, [])

  const reply = detail ? modelReply(detail.response) : ''
  return <dialog ref={dialog} className="bulk-import" aria-labelledby="ollama-activity-title" onCancel={event => {
    event.preventDefault()
    onClose()
  }}>
    <div className="ollama-activity">
      <header className="dialog-head">
        <h2 id="ollama-activity-title">Ollama activity</h2>
        <button type="button" onClick={onClose}>Close activity</button>
      </header>
      <div className="dialog-content bulk-content">
        {problem && <p role="alert" className="notice">{problem}</p>}
        {detail ? <>
          <div className="actions">
            <button type="button" onClick={() => setDetail(undefined)}>Back to activity</button>
            <button type="button" disabled={opening} onClick={() => void open(detail.id)}>Refresh request</button>
          </div>
          <h3>{detail.feature}</h3>
          <p>{detail.model} · {detail.status} · {timestamp.format(new Date(detail.started))}</p>
          <small>Token limit {detail.maxTokens}{detail.httpStatus !== null ? ` · HTTP ${detail.httpStatus}` : ''}</small>
          {detail.error && <p className="notice">{detail.error}</p>}
          <section><h3>System prompt</h3><pre>{detail.systemPrompt}</pre></section>
          <section><h3>User prompt</h3><pre>{detail.userPrompt}</pre></section>
          {reply && <section><h3>Model response</h3><pre>{reply}</pre></section>}
          {detail.response !== null ? <details open={!reply}>
            <summary>Raw Ollama response</summary><pre>{detail.response}</pre>
          </details> : <p>No response recorded.</p>}
        </> : <>
          <p>Prompts and responses from this tracker are stored in its local SQLite database.</p>
          <div><button type="button" disabled={loading || opening} onClick={() => void load()}>Refresh activity</button></div>
          {(loading || opening) && <p role="status">{opening ? 'Opening request…' : 'Loading activity…'}</p>}
          {entries.length > 0 ? <div className="bulk-grid" tabIndex={0} role="region" aria-label="Ollama request history">
            <table>
              <thead><tr><th scope="col">Started</th><th scope="col">Feature</th><th scope="col">Model</th>
                <th scope="col">Status</th><th scope="col">Prompt</th><th scope="col">Request</th></tr></thead>
              <tbody>{entries.map(entry => <tr key={entry.id}>
                <td>{timestamp.format(new Date(entry.started))}</td><td>{entry.feature}</td><td>{entry.model}</td>
                <td>{entry.status}</td><td>{entry.promptPreview}</td>
                <td><button type="button" disabled={opening} aria-label={`View request ${entry.id}`}
                  onClick={() => void open(entry.id)}>View</button></td>
              </tr>)}</tbody>
            </table>
          </div> : !loading && !problem && <p>No tracked requests yet.</p>}
          {before !== null && <div><button type="button" disabled={loading || opening}
            onClick={() => void load(before)}>Load older requests</button></div>}
        </>}
      </div>
    </div>
  </dialog>
}

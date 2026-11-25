import { useEffect, useRef, useState, type FormEvent } from 'react'
import { loadOllamaModels, loadSettings, saveOllamaSettings, type TrackerSettings } from './data'
import { OllamaActivityDialog } from './ollama-activity'

const presets = ['llama3.2:3b', 'qwen2.5:3b']
type ModelMode = 'default' | 'custom' | 'off'

export function SettingsDialog({ onClose, onSaved }: {
  onClose: () => void
  onSaved: (aiConfigured: boolean) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState<TrackerSettings>()
  const [mode, setMode] = useState<ModelMode>('default')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>()
  const [problem, setProblem] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [activityOpen, setActivityOpen] = useState(false)

  function applySettings(current: TrackerSettings) {
    setSettings(current)
    setMode(current.modelOverride === null ? 'default' : current.modelOverride ? 'custom' : 'off')
    setModel(current.model)
  }

  useEffect(() => {
    dialog.current?.showModal()
    void loadSettings().then(applySettings).catch(error => setProblem(error.message))
    void refreshModels()
  }, [])

  async function refreshModels() {
    setChecking(true)
    setConnectionError('')
    try {
      setModels(await loadOllamaModels())
    } catch (error) {
      setModels(undefined)
      setConnectionError(error instanceof Error ? error.message : 'Could not connect to Ollama.')
    } finally {
      setChecking(false)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings || saving || (mode === 'custom' && !model.trim())) return
    setSaving(true)
    setProblem('')
    setNotice('')
    try {
      const current = await saveOllamaSettings(mode === 'default' ? null : mode === 'off' ? '' : model.trim())
      applySettings(current)
      onSaved(Boolean(current.model))
      setNotice('Settings saved.')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not save settings.')
    } finally {
      setSaving(false)
    }
  }

  return <><dialog ref={dialog} aria-labelledby="settings-title" onCancel={event => {
    event.preventDefault()
    if (!saving) onClose()
  }}>
    <form onSubmit={save}>
      <header className="dialog-head">
        <h2 id="settings-title">Settings</h2>
        <button type="button" onClick={onClose} disabled={saving}>Close</button>
      </header>
      <div className="dialog-content settings-content">
        {!settings && !problem && <p role="status">Loading settings…</p>}
        {settings && <>
          <section aria-labelledby="storage-title">
            <h3 id="storage-title">Data storage</h3>
            <p>Applications and model preferences are stored in SQLite on the API host.</p>
            <code className="settings-path">{settings.databasePath}</code>
            <small>To use a different database file, set <code>TRACKER_DB_PATH</code> before starting the API.</small>
          </section>
          <section aria-labelledby="ollama-title">
            <h3 id="ollama-title">Ollama</h3>
            <p>Ollama powers job description extraction and natural-language application search.</p>
            <div className="actions">
              <code>{settings.ollamaUrl}</code>
              <button type="button" onClick={() => void refreshModels()} disabled={checking || saving}>
                {checking ? 'Checking…' : 'Check connection and refresh models'}
              </button>
              <button type="button" onClick={() => setActivityOpen(true)}>Ollama activity</button>
            </div>
            <small role="status">{checking ? 'Connecting to Ollama…' : connectionError ||
              (models ? `Connected. ${models.length} installed ${models.length === 1 ? 'model' : 'models'}.` : '')}</small>
            <fieldset disabled={saving}>
              <label>AI mode
                <select value={mode} onChange={event => { setMode(event.target.value as ModelMode); setNotice('') }}>
                  <option value="default">Use server default (OLLAMA_MODEL)</option>
                  <option value="custom">Use a selected model</option>
                  <option value="off">Disable AI</option>
                </select>
              </label>
              {mode === 'custom' && <>
                {!!models?.length && <label>Installed models
                  <select value={models.includes(model) ? model : ''} onChange={event => { setModel(event.target.value); setNotice('') }}>
                    <option value="" disabled>Choose an installed model</option>
                    {models.map(name => <option key={name}>{name}</option>)}
                  </select>
                </label>}
                <label>Model tag
                  <input value={model} onChange={event => { setModel(event.target.value); setNotice('') }}
                    placeholder={presets[0]} required maxLength={256} />
                </label>
                <div className="actions">
                  {presets.map(name => <button key={name} type="button"
                    onClick={() => { setModel(name); setNotice('') }}>{name}</button>)}
                </div>
              </>}
              <small>Active model: {settings.model || 'AI disabled'}</small>
            </fieldset>
            <details>
              <summary>Install and set up Ollama</summary>
              <ol>
                <li><a href="https://ollama.com/download" target="_blank" rel="noreferrer">Download Ollama</a> and install it on the API host.</li>
                <li>Start the Ollama app or run <code>ollama serve</code> in a terminal.</li>
                <li>Download a model with <code>ollama pull {presets[0]}</code>, or choose another from the <a href="https://ollama.com/library" target="_blank" rel="noreferrer">model library</a>.</li>
                <li>Refresh the installed models, choose one, and save.</li>
              </ol>
            </details>
          </section>
        </>}
        {problem && <p role="alert" className="notice">{problem}</p>}
        {notice && <p role="status" className="notice">{notice}</p>}
      </div>
      <footer className="dialog-foot">
        <button type="submit" className="primary" disabled={!settings || saving || (mode === 'custom' && !model.trim())}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </footer>
    </form>
  </dialog>{activityOpen && <OllamaActivityDialog onClose={() => setActivityOpen(false)} />}</>
}

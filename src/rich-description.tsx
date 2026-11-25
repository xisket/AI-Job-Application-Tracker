import { useEffect, useId, useRef } from 'react'
import { cleanDescriptionHtml, descriptionMarkup } from './description-html'

export function RichDescription({ text, html, disabled, onChange }: {
  text: string
  html: string
  disabled: boolean
  onChange: (text: string, html: string) => void
}) {
  const editor = useRef<HTMLDivElement>(null)
  const lastEdit = useRef<{ text: string; html: string } | undefined>(undefined)
  const label = useId()
  useEffect(() => {
    if (editor.current && (lastEdit.current?.text !== text || lastEdit.current?.html !== html))
      editor.current.innerHTML = descriptionMarkup(text, html)
  }, [html, text])

  function update() {
    const node = editor.current
    if (!node) return
    const text = node.innerText.slice(0, 45000)
    const html = text.trim() ? cleanDescriptionHtml(node.innerHTML) : ''
    lastEdit.current = { text, html }
    onChange(text, html)
  }

  return <div className="rich-description">
    <div id={label} className="rich-label">Job description</div>
    <div className="actions rich-toolbar" role="group" aria-label="Description formatting">
      {([
        ['bold', 'Bold', 'B'], ['italic', 'Italic', 'I'], ['underline', 'Underline', 'U'],
        ['insertUnorderedList', 'Bulleted list', '• List'], ['insertOrderedList', 'Numbered list', '1. List'],
        ['formatBlock', 'Heading', 'Heading', 'h3'],
      ] as const).map(([command, name, icon, value]) => <button type="button" key={command} aria-label={name}
        title={name} onMouseDown={event => event.preventDefault()} onClick={() => {
          editor.current?.focus()
          document.execCommand(command, false, value)
          update()
        }}>{icon}</button>)}
    </div>
    <div className="rich-editable" ref={editor} contentEditable={!disabled} suppressContentEditableWarning role="textbox"
      tabIndex={disabled ? -1 : 0} aria-labelledby={label} aria-multiline="true" aria-readonly={disabled} onInput={update}
      onDrop={event => event.preventDefault()}
      onPaste={event => {
        event.preventDefault()
        const data = event.clipboardData
        const html = data.getData('text/html')
        if (html) document.execCommand('insertHTML', false, cleanDescriptionHtml(html))
        else document.execCommand('insertText', false, data.getData('text/plain').slice(0, 45000))
        update()
      }} />
  </div>
}

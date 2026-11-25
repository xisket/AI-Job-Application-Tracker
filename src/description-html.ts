const allowed = new Set(['a', 'b', 'blockquote', 'br', 'div', 'em', 'h2', 'h3', 'h4', 'i', 'li', 'ol', 'p', 'strong', 'u', 'ul'])
const omitted = new Set(['script', 'style', 'template', 'iframe', 'object', 'svg', 'math'])

export function cleanDescriptionHtml(value: string) {
  const source = document.createElement('template')
  source.innerHTML = value.slice(0, 120000)
  const result = document.createElement('div')
  function copy(node: Node, target: HTMLElement, depth: number) {
    if (depth > 40) return
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.textContent ?? '')
      return
    }
    if (!(node instanceof Element) || omitted.has(node.localName)) return
    const element = allowed.has(node.localName) ? document.createElement(node.localName) : target
    if (element !== target) {
      if (node.localName === 'a') {
        const href = node.getAttribute('href') ?? ''
        if (/^https?:\/\//i.test(href)) {
          element.setAttribute('href', href)
          element.setAttribute('rel', 'noopener noreferrer')
        }
      }
      target.append(element)
    }
    node.childNodes.forEach(child => copy(child, element, depth + 1))
  }
  source.content.childNodes.forEach(child => copy(child, result, 0))
  return result.innerHTML
}

export function descriptionMarkup(text: string, html: string) {
  const sanitized = html ? cleanDescriptionHtml(html) : ''
  if (sanitized.includes('<')) return sanitized
  const container = document.createElement('div')
  container.textContent = text
  return container.innerHTML.replace(/\r?\n/g, '<br>')
}

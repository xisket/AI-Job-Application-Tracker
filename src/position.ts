import { safeUrl, type Draft } from './model'

export function positionDetails(position: Draft) {
  return {
    title: position.role.trim() || 'Untitled position',
    company: position.company.trim(),
    url: safeUrl(position.url),
    facts: [
      ['Status', position.stage], ['Location', position.location], ['Work arrangement', position.arrangement],
      ['Salary', position.salary], ['Date posted', position.posted], ['Date applied', position.applied], ['Application deadline', position.deadline],
      ['Interview date', position.interview], ['Next action', position.next], ['Follow-up due', position.due],
    ].filter(([, value]) => value),
    sections: [
      ['Requirements', position.requirements], ['Job description', position.description], ['Personal notes', position.notes],
    ].filter(([, value]) => value?.trim()),
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!))
}

export function positionHtml(position: Draft) {
  const { title, company, url, facts, sections } = positionDetails(position)
  const html = escapeHtml
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    html(title) + '</title><style>body{font:16px/1.55 system-ui;color:#20281e;max-width:760px;margin:32px auto;padding:0 20px;overflow-wrap:anywhere}h1{line-height:1.1}h2{border-top:1px solid #d9ded4;padding-top:16px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:14px;background:#f2f4eb;padding:16px}dt{font-size:.85em;color:#505a49}dd{margin:0}section p{white-space:pre-wrap}a{color:#314e21}</style><body><main><header><h1>' +
    html(title) + '</h1><p>' + html(company) + '</p></header><dl>' +
    facts.map(([label, value]) => '<div><dt>' + html(label) + '</dt><dd>' + html(value) + '</dd></div>').join('') +
    '</dl>' + (url ? '<p><a href="' + html(url) + '">View original posting</a></p>' : '') +
    sections.map(([label, value]) => '<section><h2>' + html(label) + '</h2><p>' + html(value) + '</p></section>').join('') +
    '</main></body></html>'
}

export function positionFilename(position: Draft) {
  return [position.company, position.role].filter(Boolean).join('-').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90) || 'position'
}

export function downloadFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export async function positionPdf(position: Draft) {
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
    import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts'),
  ])

  const { title, company, url, facts, sections } = positionDetails(position)
  return new Promise<Blob>(resolve => pdfMake.createPdf({
    info: { title },
    content: [
      { text: title, fontSize: 26, bold: true, color: '#243b25' },
      { text: company, fontSize: 16, margin: [0, 6, 0, 16] },
      ...facts.map(([label, value]) => ({ text: [{ text: label + '  ', bold: true }, value], margin: [0, 0, 0, 4] as [number, number, number, number] })),
      ...(url ? [{ text: 'View original posting', link: url, color: '#315d31' }] : []),
      ...sections.flatMap(([label, value]) => [
        { text: label, fontSize: 16, bold: true, margin: [0, 18, 0, 6] as [number, number, number, number] }, { text: value },
      ]),
    ],
    defaultStyle: { fontSize: 11, lineHeight: 1.25 },
  }, undefined, undefined, fonts).getBlob(resolve))
}



import { addDays, extraction, today, type Draft } from './model'

function relativeDate(text: string, reference: string) {
  if (/^(today|just now)$/i.test(text)) return reference
  if (/^yesterday$/i.test(text)) return addDays(reference, -1)
  const age = text.match(/^(\d{1,4})\s+(minute|hour|day|week)s? ago$/i)
  if (!age) return undefined
  const unit = age[2].toLowerCase()
  const days = unit === 'week' ? Number(age[1]) * 7 : unit === 'day' ? Number(age[1]) : 0
  return addDays(reference, -days)
}

export function parseLinkedInPaste(text: string, reference = today()): Partial<Draft> | undefined {
  const lines = text.replace(/&(?:nbsp|#x20|#32);/gi, ' ').replace(/\u00a0/g, ' ')
    .replace(/\\(?=\r?$)/gm, '').split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:#{1,6}|[-*])\s+/, '').replace(/^\*\*(.+)\*\*$/, '$1'))
    .filter(Boolean)

  const hiring = lines.slice(2, 12).find(line => /^See who .+ has hired for this role$/i.test(line))
  const publicCompany = hiring?.match(/^See who (.+) has hired for this role$/i)?.[1]
  const metadata = lines[1]?.match(/^(.+?)\s*·\s*([^·]+?)\s*·\s*[\d,.+]+\s+people clicked apply\s*$/i)
  const publicHeader = publicCompany && lines[1]?.startsWith(publicCompany)
  if (!lines[0] || (!publicHeader && !metadata)) return undefined

  const company = publicHeader ? publicCompany : lines.map(line => line.match(/^En (.+?) estamos buscando talento\b/i)?.[1]).find(Boolean)
  const location = metadata?.[1] ?? (publicCompany ? lines[1].slice(publicCompany.length).trim().replace(/^[·|–]\s*/, '') : '')
  const publicAge = publicHeader ? lines[2]?.match(/^(.+? ago)\s+[\d,.+]+\s+applicants?$/i)?.[1] : undefined
  const posted = relativeDate(metadata?.[2] ?? publicAge ?? '', reference)
  const status = lines.findIndex(line => /^application status$/i.test(line))
  const applied = status >= 0 && /^applied(?: on company site)?$/i.test(lines[status + 1] ?? '')
    ? relativeDate(lines[status + 2] ?? '', reference) : undefined
  const requirementsStart = lines.findIndex(line => /^(?:\p{Extended_Pictographic}\s*)?(?:requisitos imprescindibles|requisitos|requirements|qualifications)\s*:?$/iu.test(line))
  const requirements = requirementsStart < 0 ? [] : lines.slice(requirementsStart + 1)
  const nextSection = requirements.findIndex(line =>
    /^(?:\p{Extended_Pictographic}[\uFE0F\s]*|(?:funciones y responsabilidades|responsibilities|show more|seniority level)\s*:?$)/iu.test(line))
  const salary = lines.map(line => line.match(/\d[\d.,]*\s*€\s*[-–—]\s*\d[\d.,]*\s*€(?:\s+brutos?\s+anuales?)?/i)?.[0]).find(Boolean)
  const arrangement = lines.find(line => /^modalidad\s+(?:remot[ao]|h[ií]brid[ao]|presencial)/i.test(line))
    ?.replace(/^modalidad\s+/i, '').replace(/\.$/, '')
  const draft = extraction(JSON.stringify({
    role: lines[0], company, location, salary, arrangement, posted, applied,
    requirements: requirements.slice(0, nextSection < 0 ? undefined : nextSection).join('\n'),
  }))
  if (applied) draft.stage = 'Applied'
  return draft
}

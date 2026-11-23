export const stages = ['Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Accepted', 'Rejected', 'Withdrawn'] as const
export type Stage = typeof stages[number]
export const closed = (stage: Stage) => ['Accepted', 'Rejected', 'Withdrawn'].includes(stage)

export const extractedFields = {
  role: 160, company: 160, location: 160, arrangement: 80, salary: 120,
  deadline: 10, posted: 10, applied: 10, requirements: 3000,
} as const
export const blank = {
  role: '', company: '', location: '', arrangement: '', salary: '', deadline: '',
  requirements: '', url: '', description: '', posted: '', applied: '', notes: '', next: '', due: '', interview: '',
  stage: 'Saved' as Stage,
}
export type Draft = typeof blank
export type Entry = { id: string; date: string; kind: string; text: string }
export type Job = Draft & { id: string; updated: string; created?: string; history: Entry[]; reminders?: Record<string, { done?: boolean; snoozed?: string }> }
export type RecordItem = { job: Job; etag?: string }

export function safeUrl(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

export function today() {
  const date = new Date()
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function extraction(text: string): Partial<Draft> {
  const parsed: unknown = JSON.parse(text.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The extraction returned an invalid draft.')
  const fields = parsed as Record<string, unknown>
  const draft: Partial<Draft> = {}
  for (const key of Object.keys(extractedFields) as (keyof typeof extractedFields)[]) {
    const value = fields[key]
    if (typeof value !== 'string') continue
    const clean = value.trim()
    if (['deadline', 'posted', 'applied'].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(clean) || !Number.isFinite(Date.parse(clean)) || new Date(clean).toISOString().slice(0, 10) !== clean)) continue
    if (clean) draft[key] = clean.slice(0, extractedFields[key])
  }
  if (!Object.keys(draft).length) throw new Error('No job details were found. You can fill in the draft manually.')
  return draft
}


export function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

export function positionDate(job: Job) {
  if (job.applied) return job.applied
  const created = job.created || job.history.find(item => item.kind === 'Added')?.date || job.history[0]?.date || job.updated
  if (/^\d{4}-\d{2}-\d{2}$/.test(created)) return created
  const date = new Date(created)
  return Number.isFinite(date.getTime()) ? dateKey(date) : ''
}

export function addDays(day: string, amount: number) {
  const date = new Date(day + 'T12:00:00')
  date.setDate(date.getDate() + amount)
  return dateKey(date)
}

export type Reminder = {
  key: string
  type: 'Follow-up' | 'Interview' | 'Application deadline'
  date: string
  originalDate: string
  title: string
  record: RecordItem
}

export function reminders(records: RecordItem[]) {
  return records.flatMap(record => {
    const { job } = record
    if (closed(job.stage)) return []
    const candidates = [
      { type: 'Follow-up', originalDate: job.due, title: job.next || 'Follow up' },
      { type: 'Interview', originalDate: job.interview, title: 'Interview' },
      { type: 'Application deadline', originalDate: job.deadline, title: 'Application deadline' },
    ] as const
    return candidates.flatMap(candidate => {
      if (!candidate.originalDate || (candidate.type === 'Application deadline' && (job.applied || job.stage !== 'Saved'))) return []
      const key = candidate.type + ':' + candidate.originalDate
      const state = job.reminders?.[key]
      return state?.done ? [] : [{ ...candidate, key, date: state?.snoozed ?? candidate.originalDate, record }]
    })
  }).sort((a, b) => a.date.localeCompare(b.date))
}


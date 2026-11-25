import type { Job } from './model'

export type ApplicationSort = 'default' | 'salary-asc' | 'salary-desc' | 'applied-asc' | 'applied-desc' | 'company-asc' | 'company-desc'

const companyOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function salaryAmount(salary: string) {
  const amounts = [...salary.matchAll(/\d+(?:(?:[.,]|[ \u00a0\u202f](?=\d{3}(?!\d)))\d+)*(?:\s*([km])\b)?/gi)]
  const first = amounts[0]
  if (!first) return undefined
  const number = first[0].replace(/[\s\u00a0\u202fkm]/gi, '')
  const decimal = /[.,]\d{1,2}$/.exec(number)
  const whole = (decimal ? number.slice(0, decimal.index) : number).replace(/[.,]/g, '')
  const amount = Number(whole + (decimal ? '.' + decimal[0].slice(1) : ''))
  const next = amounts[1]
  const between = next ? salary.slice(first.index + first[0].length, next.index) : ''
  const suffix = first[1] ?? (amount < 1000 && /^\s*[-–—]\s*(?:\p{Sc}|[A-Z]{3})?\s*$/iu.test(between)
    ? next?.[1] : undefined)
  return Number.isFinite(amount) ? amount * ({ k: 1000, m: 1_000_000 }[suffix?.toLowerCase() ?? ''] ?? 1) : undefined
}

export function compareApplications(left: Job, right: Job, sort: Exclude<ApplicationSort, 'default'>) {
  const direction = sort.endsWith('-asc') ? 1 : -1
  if (sort.startsWith('company')) return direction * companyOrder.compare(left.company, right.company)
  const value = sort.startsWith('salary')
    ? (job: Job) => salaryAmount(job.salary)
    : (job: Job) => { const date = Date.parse(job.applied); return Number.isNaN(date) ? undefined : date }
  const a = value(left)
  const b = value(right)
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return direction * (a - b)
}

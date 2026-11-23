import { useEffect, useState } from 'react'
import { addDays, dateKey, positionDate, today, type RecordItem, type Reminder } from './model'
import { downloadFile } from './position'

export function Calendar({ records, year, from, onOpen }: {
  records: RecordItem[]; year: string; from: string; onOpen: (record: RecordItem) => void
}) {
  const [month, setMonth] = useState(today().slice(0, 7))
  const [selected, setSelected] = useState('')
  useEffect(() => {
    setSelected('')
    if (from && (!year || from.startsWith(year))) setMonth(from.slice(0, 7))
    else if (year) setMonth(year + (today().startsWith(year) ? today().slice(4, 7) : '-01'))
  }, [year, from])

  const currentDay = today()
  const grouped = new Map<string, RecordItem[]>()
  for (const record of records) {
    const key = positionDate(record.job)
    grouped.set(key, [...(grouped.get(key) ?? []), record])
  }
  const start = new Date(month + '-01T12:00:00')
  const gridStart = addDays(month + '-01', -(start.getDay() + 6) % 7)
  const heading = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(start)
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
  const changeMonth = (amount: number) => {
    start.setMonth(start.getMonth() + amount)
    setMonth(dateKey(start).slice(0, 7))
    setSelected('')
  }

  return <section className="calendar" aria-label="Positions calendar">
    <div className="calendar-header">
      <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</button>
      <h2 aria-live="polite">{heading}</h2>
      <button type="button" aria-label="Next month" onClick={() => changeMonth(1)}>›</button>
    </div>
    <div className="calendar-grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span className="weekday" key={day}>{day}</span>)}
      {Array.from({ length: 42 }, (_, offset) => {
        const key = addDays(gridStart, offset)
        const count = grouped.get(key)?.length ?? 0
        return key.startsWith(month) ? <button key={key} type="button" aria-pressed={selected === key}
          data-positions={count ? (key < currentDay ? 'past' : 'current') : undefined}
          aria-label={format.format(new Date(key + 'T12:00:00')) + ', ' + count + ' positions'} onClick={() => setSelected(key)}>
          <span>{Number(key.slice(8))}</span><strong>{count}</strong>
        </button> : <span key={key} className="calendar-blank" />
      })}
    </div>
    {selected && <section className="calendar-results">
      <h3>{format.format(new Date(selected + 'T12:00:00'))}</h3>
      {(grouped.get(selected) ?? []).map(record => <button key={record.job.id} onClick={() => onOpen(record)}>{record.job.role} · {record.job.company}</button>)}
      {!grouped.has(selected) && <p>No positions.</p>}
    </section>}
  </section>
}

const taskDay = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const showDay = (date: string) => taskDay.format(new Date(date + 'T12:00:00'))

function icalText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|[\r\n]/g, '\\n').replace(/[;,]/g, '\\$&')
}

async function downloadReminder(task: Reminder) {
  const job = task.record.job
  const compact = (date: string) => date.replaceAll('-', '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Job Application Tracker//Reminders//EN',
    'BEGIN:VEVENT', 'UID:' + icalText(job.id + '-' + task.key) + '@job-application-tracker',
    'DTSTAMP:' + new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
    'DTSTART:' + compact(task.date) + 'T090000', 'DTEND:' + compact(task.date) + 'T091500',
    'SUMMARY:' + icalText(task.title + ' - ' + job.company),
    'DESCRIPTION:' + icalText([job.role, job.url].filter(Boolean).join('\n')),
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Job application reminder',
    'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ]
  const encoder = new TextEncoder()
  const folded = lines.map(line => {
    let result = ''
    let bytes = 0
    for (const character of line) {
      const length = encoder.encode(character).length
      if (bytes + length > 75) {
        result += '\r\n '
        bytes = 1
      }
      result += character
      bytes += length
    }
    return result
  })
  const name = 'application-reminder.ics'
  const file = new Blob([folded.join('\r\n') + '\r\n'], { type: 'text/calendar' })
  downloadFile(file, name)
}

export function TodayView({ tasks, onOpen, onChange, busy }: {
  tasks: Reminder[]; onOpen: (record: RecordItem) => void
  onChange: (task: Reminder, action: 'done' | 'snooze') => void; busy: boolean
}) {
  const [problem, setProblem] = useState('')
  const day = today()
  const groups = [
    { label: 'Overdue', matches: tasks.filter(task => task.date < day) },
    { label: 'Due today', matches: tasks.filter(task => task.date === day) },
    { label: 'Upcoming', matches: tasks.filter(task => task.date > day) },
  ]
  return <section className="today" aria-label="Today and upcoming reminders">
    <p>Application deadlines, interviews, and scheduled follow-ups. Exported calendar reminders default to 9 AM local time.</p>
    {problem && <p className="notice" role="alert">{problem}</p>}
    {!tasks.length && <p>No reminders. Set a due date or interview date on a position to add one.</p>}
    {groups.filter(group => group.matches.length).map(group => <section key={group.label}>
      <h2>{group.label}</h2>
      <ul>{group.matches.map(task => <li key={task.record.job.id + task.key}>
        <div className="task-header">
          <button className="text-button" onClick={() => onOpen(task.record)}>{task.record.job.role} · {task.record.job.company}</button>
          <small>{showDay(task.date)}{task.date !== task.originalDate ? ' · Snoozed' : ''}</small>
        </div>
        <p>{task.title}</p>
        <div className="actions">
          <button disabled={busy} onClick={() => onChange(task, 'done')}>Mark done</button>
          <button disabled={busy} onClick={() => onChange(task, 'snooze')}>Snooze 1 day</button>
          <button onClick={() => {
            setProblem('')
            void downloadReminder(task).catch(() => setProblem('Could not export the calendar reminder.'))
          }} aria-label="Calendar reminder at 9 AM">Calendar reminder</button>
        </div>
      </li>)}</ul>
    </section>)}
  </section>
}



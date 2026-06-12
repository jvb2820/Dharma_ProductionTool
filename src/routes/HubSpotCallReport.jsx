import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadHubSpotCallReport } from '../services/hubspotCallReport'

const reportTimeZone = 'America/New_York'
const defaultAverageRuntimeMs = 45000
const averageRuntimeCacheKey = 'hubspot-call-report-average-runtime-ms'
const outboundAssignmentStorageKey = 'hubspot-call-report-outbound-assignments'
const missingCallerName = 'No caller found'
const outboundCallerAssignments = [
  {
    id: 'laura-main',
    ownerName: 'Laura Sanchez',
    agentNames: [
      'Alejandro Rivera',
      'Leonardo Goncalves',
      'Meribet Yazziet',
      'María Claudia',
      'Maria Claudia',
      'MarÃ­a Claudia',
    ],
  },
  {
    id: 'juan-main',
    ownerName: 'Juan Camilo',
    agentNames: [
      'Alice F',
      'Alice Strelow',
      'Arles Martinez',
      'Brayam Zuluaga',
      'Edmilson Morales',
      'Edmilson Velasquez',
    ],
  },
  {
    id: 'juan-secondary',
    ownerName: 'Juan Camilo',
    agentNames: [
      'Maria Sandoval',
      'Paula Alfonso',
    ],
  },
]

function normalizePersonName(value) {
  const normalizedName = String(value ?? '')
    .replace(/Ã­a/g, 'ia')
    .replace(/Ã/g, 'a')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

  if (normalizedName.startsWith('laura alejandra sanchez')) return 'laura sanchez'

  return normalizedName
}

function getDisplayPersonName(value) {
  const normalizedName = normalizePersonName(value)

  if (normalizedName === 'laura sanchez') return 'Laura Sanchez'
  if (normalizedName === 'maria claudia') return 'María Claudia'
  if (normalizedName === 'alice strelow') return 'Alice F'
  if (normalizedName === 'edmilson morales') return 'Edmilson Velasquez'

  return value
}

function normalizeOutboundAssignmentOverrides(value) {
  return Object.entries(value ?? {}).reduce((lookup, [ownerName, assignedCallerName]) => {
    const displayName = getDisplayPersonName(assignedCallerName)

    if (displayName && displayName !== ownerName) {
      lookup[ownerName] = displayName
    }

    return lookup
  }, {})
}

function createEmptyAssignmentStats(assignment, assignedCallerName = assignment.ownerName) {
  return {
    ...assignment,
    callerName: assignedCallerName,
    confirmedCalled: 0,
    totalAppointments: 0,
    notCalled: 0,
    notCalledRows: [],
    meetingHosts: new Map(assignment.agentNames.map((agentName) => [
      normalizePersonName(agentName),
      {
        meetingHostName: agentName,
        totalAppointments: 0,
        confirmedCalled: 0,
        notCalled: 0,
        notCalledRows: [],
      },
    ])),
  }
}

function getNewYorkDate(offsetDays = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: reportTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''

  return `${part('year')}-${part('month')}-${part('day')}`
}

function formatDate(value) {
  if (value?.includes('/')) return value

  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00Z`))
}

function formatWeekday(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    weekday: 'long',
  }).format(
    new Date(`${value}T12:00:00Z`),
  )
}

function parseReportDate(value) {
  if (!value) return null
  if (value.includes('/')) {
    const [month, day, year] = value.split('/').map(Number)

    return new Date(year, month - 1, day)
  }

  return new Date(`${value}T00:00:00`)
}

function formatActivityDate(slot) {
  const activityDate = slot.scheduledAt
    ? new Date(slot.scheduledAt)
    : parseReportDate(slot.date)

  if (!activityDate || Number.isNaN(activityDate.getTime())) return '-'

  const formattedDate = new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(activityDate)

  return formattedDate.replace(',', ',')
}

function getDateGroupLabel(value) {
  if (value === getNewYorkDate()) return 'TODAY'
  if (value === getNewYorkDate(-1)) return 'YESTERDAY'

  return formatDate(value)
}

function getTimeZoneLabel() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value ?? 'ET'
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes === 0) return `${seconds}s`

  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function readAverageRuntimeMs() {
  try {
    const cachedValue = Number(window.sessionStorage.getItem(averageRuntimeCacheKey))

    return Number.isFinite(cachedValue) && cachedValue > 0 ? cachedValue : defaultAverageRuntimeMs
  } catch {
    return defaultAverageRuntimeMs
  }
}

function writeAverageRuntimeMs(value) {
  try {
    window.sessionStorage.setItem(averageRuntimeCacheKey, String(Math.round(value)))
  } catch {
    // Timing stats are optional; loading still works without session storage.
  }
}

function readOutboundAssignmentOverrides() {
  try {
    const overrides = normalizeOutboundAssignmentOverrides(
      JSON.parse(window.localStorage.getItem(outboundAssignmentStorageKey)) ?? {},
    )

    writeOutboundAssignmentOverrides(overrides)
    return overrides
  } catch {
    return {}
  }
}

function writeOutboundAssignmentOverrides(value) {
  try {
    window.localStorage.setItem(outboundAssignmentStorageKey, JSON.stringify(value))
  } catch {
    // Assignment overrides are optional; the defaults still match the roster.
  }
}

function getMeetingName(slot) {
  return slot.meetingName || `${slot.clientName || 'Client'} Analysis with Dharma Clinic`
}

function getMeetingDescription(slot) {
  return slot.meetingDescription || [
    slot.clientName ? `Name: ${slot.clientName}` : '',
    slot.clientEmail ? `Email: ${slot.clientEmail}` : '',
    slot.phoneNumber ? `Phone: ${slot.phoneNumber}` : '',
  ].filter(Boolean).join('')
}

function isCancelledMeeting(value) {
  return /\bcancell?ed\b|\bcancelad[ao]\b|\bcancel/i.test(String(value ?? ''))
}

function HubSpotCallReport() {
  const topScrollRef = useRef(null)
  const tableScrollRef = useRef(null)
  const topScrollContentRef = useRef(null)
  const [report, setReport] = useState({
    source: 'sample',
    rows: [],
    callerAnalytics: [],
    reportDate: null,
    updatedAt: null,
  })
  const [selectedDate, setSelectedDate] = useState(() => getNewYorkDate(-1))
  const [status, setStatus] = useState('ready')
  const [error, setError] = useState('')
  const [loadingStartedAt, setLoadingStartedAt] = useState(() => Date.now())
  const [loadingElapsedMs, setLoadingElapsedMs] = useState(0)
  const [averageRuntimeMs, setAverageRuntimeMs] = useState(() => readAverageRuntimeMs())
  const [notCalledDialog, setNotCalledDialog] = useState(null)
  const [outboundAssignmentOverrides, setOutboundAssignmentOverrides] = useState(() => readOutboundAssignmentOverrides())
  const [draftOutboundAssignmentOverrides, setDraftOutboundAssignmentOverrides] = useState(() => readOutboundAssignmentOverrides())
  const averageRuntimeRef = useRef(averageRuntimeMs)

  const recordRuntime = useCallback((durationMs) => {
    const nextAverageMs = (averageRuntimeRef.current * 0.7) + (durationMs * 0.3)

    averageRuntimeRef.current = nextAverageMs
    setAverageRuntimeMs(nextAverageMs)
    writeAverageRuntimeMs(nextAverageMs)
  }, [])

  useEffect(() => {
    if (status !== 'loading') return undefined

    const updateElapsed = () => {
      setLoadingElapsedMs(Date.now() - loadingStartedAt)
    }
    const intervalId = window.setInterval(updateElapsed, 500)

    updateElapsed()

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadingStartedAt, status])

  function updateSelectedDate(nextDate) {
    if (nextDate === selectedDate) return

    setError('')
    setLoadingElapsedMs(0)
    setSelectedDate(nextDate)
  }

  function fetchSelectedReport() {
    const startedAt = Date.now()
    const nextOverrides = normalizeOutboundAssignmentOverrides(draftOutboundAssignmentOverrides)

    writeOutboundAssignmentOverrides(nextOverrides)
    setOutboundAssignmentOverrides(nextOverrides)
    setDraftOutboundAssignmentOverrides(nextOverrides)
    setStatus('loading')
    setError('')
    setLoadingStartedAt(startedAt)
    setLoadingElapsedMs(0)

    loadHubSpotCallReport(selectedDate, { forceRefresh: true })
      .then((data) => {
        recordRuntime(Date.now() - startedAt)
        setReport(data)
        setStatus('ready')
      })
      .catch((loadError) => {
        setError(loadError.message)
        setStatus('error')
      })
  }

  function updateDraftOutboundAssignment(ownerName, assignedCallerName) {
    setDraftOutboundAssignmentOverrides((currentOverrides) => {
      const displayName = getDisplayPersonName(assignedCallerName)
      const nextOverrides = {
        ...currentOverrides,
        [ownerName]: displayName,
      }

      if (displayName === ownerName) {
        delete nextOverrides[ownerName]
      }

      return nextOverrides
    })
  }

  const scheduleRows = useMemo(() => {
    return report.rows.map((row) => {
      const meetingName = row.meetingName
      const callerName = row.callerName
      const cancelled = isCancelledMeeting(meetingName)

      return {
        rowId: row.rowId,
        meetingName,
        meetingDescription: row.meetingDescription,
        date: row.date,
        time: row.time,
        clientName: row.clientName,
        clientEmail: row.clientEmail,
        phoneNumber: row.phoneNumber,
        scheduledAgent: row.scheduledAgent,
        meetingHost: row.meetingHost,
        scheduledAt: row.scheduledAt,
        callerName,
        qualifyingCallers: row.qualifyingCallers ?? (callerName ? [callerName] : []),
        previousDayCallerName: row.previousDayCallerName ?? '',
        previousDayCallers: row.previousDayCallers ?? [],
        previousDayCalledDetail: row.previousDayCalledDetail ?? '',
        called: callerName ? 'Called' : 'Not Called',
        calledDetail: callerName
          ? row.calledDetail || 'Outbound caller found before the appointment'
          : row.calledDetail || 'No qualifying outbound call found',
        confirmation: cancelled ? 'Not Confirmed' : 'Confirmed',
        confirmationDetail: cancelled
          ? 'Meeting name indicates the appointment was cancelled'
          : 'Meeting name does not indicate cancellation',
      }
    })
  }, [report.rows])

  const reportDateLabel = report.reportDate ? formatDate(report.reportDate) : ''
  const reportWeekday = report.reportDate ? formatWeekday(report.reportDate) : 'Loading'
  const timeZoneLabel = getTimeZoneLabel()
  const totalConfirmedAppointments = useMemo(() => {
    return scheduleRows.filter((row) => row.confirmation === 'Confirmed').length
  }, [scheduleRows])
  const totalCalledConfirmedAppointments = useMemo(() => {
    return scheduleRows.filter((row) =>
      row.confirmation === 'Confirmed' && row.called === 'Called',
    ).length
  }, [scheduleRows])
  const outboundCallerOptions = useMemo(() => {
    return [...new Set([
      ...outboundCallerAssignments.map((assignment) => assignment.ownerName),
      ...outboundCallerAssignments.flatMap((assignment) => assignment.agentNames),
      ...scheduleRows.map((row) => row.callerName),
      ...scheduleRows.map((row) => row.meetingHost),
    ].filter(Boolean).map(getDisplayPersonName))]
      .sort((left, right) => left.localeCompare(right))
  }, [scheduleRows])
  const outboundAssignmentOwners = useMemo(() => {
    return [...new Set(outboundCallerAssignments.map((assignment) => assignment.ownerName))]
  }, [])
  const confirmedCallsByAgent = useMemo(() => {
    const assignmentRows = outboundCallerAssignments.map((assignment) => {
      const assignedCallerName = outboundAssignmentOverrides[assignment.ownerName] || assignment.ownerName

      return createEmptyAssignmentStats(assignment, assignedCallerName)
    })
    const assignmentByAgentName = assignmentRows.reduce((lookup, assignment) => {
      assignment.agentNames.forEach((agentName) => {
        lookup.set(normalizePersonName(agentName), assignment)
      })

      return lookup
    }, new Map())
    const unassignedRows = new Map()

    scheduleRows.forEach((row) => {
      const meetingHostName = row.meetingHost || 'Unassigned'
      const assignedGroup = assignmentByAgentName.get(normalizePersonName(meetingHostName))
      const caller = assignedGroup ?? unassignedRows.get(missingCallerName) ?? createEmptyAssignmentStats({
        id: 'unassigned',
        ownerName: missingCallerName,
        agentNames: [],
      }, missingCallerName)
      const assignedCallerCalled = assignedGroup
        ? (row.qualifyingCallers ?? []).some((callerName) =>
          normalizePersonName(callerName) === normalizePersonName(caller.callerName),
        )
        : row.called === 'Called'
      const meetingHost = caller.meetingHosts.get(meetingHostName) ?? {
        meetingHostName,
        totalAppointments: 0,
        confirmedCalled: 0,
        notCalled: 0,
        notCalledRows: [],
      }

      caller.totalAppointments += 1
      meetingHost.totalAppointments += 1
      if (row.confirmation === 'Confirmed' && !assignedCallerCalled) {
        caller.notCalled += 1
        meetingHost.notCalled += 1
        caller.notCalledRows.push(row)
        meetingHost.notCalledRows.push(row)
      } else if (row.confirmation === 'Confirmed' && assignedCallerCalled) {
        caller.confirmedCalled += 1
        meetingHost.confirmedCalled += 1
      }

      caller.meetingHosts.set(meetingHostName, meetingHost)
      if (!assignedGroup) {
        unassignedRows.set(missingCallerName, caller)
      }
    })

    return [...assignmentRows, ...unassignedRows.values()]
      .map((agent) => ({
        ...agent,
        meetingHosts: [...agent.meetingHosts.values()]
          .filter((meetingHost) => meetingHost.totalAppointments > 0)
          .sort((left, right) =>
            right.totalAppointments - left.totalAppointments
            || right.confirmedCalled - left.confirmedCalled
            || left.meetingHostName.localeCompare(right.meetingHostName),
          ),
        confirmedShare: scheduleRows.length > 0
          ? Math.round((agent.totalAppointments / scheduleRows.length) * 100)
          : 0,
      }))
      .sort((left, right) =>
        right.totalAppointments - left.totalAppointments
        || right.confirmedCalled - left.confirmedCalled
        || left.callerName.localeCompare(right.callerName),
      )
  }, [outboundAssignmentOverrides, scheduleRows])
  const juanPreviousDayCalling = useMemo(() => {
    const assignment = outboundCallerAssignments.find((entry) => entry.id === 'juan-secondary')
    if (!assignment) return null

    const assignedCallerName = outboundAssignmentOverrides[assignment.ownerName] || assignment.ownerName
    const assignedCallerKey = normalizePersonName(assignedCallerName)
    const agentRows = createEmptyAssignmentStats({
      ...assignment,
      id: 'juan-previous-day',
    }, assignedCallerName)
    const assignmentByAgentName = new Map(
      assignment.agentNames.map((agentName) => [normalizePersonName(agentName), agentName]),
    )

    scheduleRows.forEach((row) => {
      const meetingHostName = row.meetingHost || 'Unassigned'
      const rosterAgentName = assignmentByAgentName.get(normalizePersonName(meetingHostName))
      if (!rosterAgentName) return

      const meetingHost = agentRows.meetingHosts.get(normalizePersonName(rosterAgentName))
      const previousDayCalledByAssignedCaller = (row.previousDayCallers ?? [])
        .some((callerName) => normalizePersonName(callerName) === assignedCallerKey)

      agentRows.totalAppointments += 1
      meetingHost.totalAppointments += 1

      if (row.confirmation === 'Confirmed' && !previousDayCalledByAssignedCaller) {
        agentRows.notCalled += 1
        meetingHost.notCalled += 1
        agentRows.notCalledRows.push(row)
        meetingHost.notCalledRows.push(row)
      } else if (row.confirmation === 'Confirmed' && previousDayCalledByAssignedCaller) {
        agentRows.confirmedCalled += 1
        meetingHost.confirmedCalled += 1
      }
    })

    return {
      ...agentRows,
      meetingHosts: [...agentRows.meetingHosts.values()]
        .filter((meetingHost) => meetingHost.totalAppointments > 0)
        .sort((left, right) =>
          right.totalAppointments - left.totalAppointments
          || left.meetingHostName.localeCompare(right.meetingHostName),
        ),
      confirmedShare: scheduleRows.length > 0
        ? Math.round((agentRows.totalAppointments / scheduleRows.length) * 100)
        : 0,
    }
  }, [outboundAssignmentOverrides, scheduleRows])
  const confirmedRate = scheduleRows.length > 0
    ? Math.round((totalConfirmedAppointments / scheduleRows.length) * 100)
    : 0
  const confirmedCalledRate = totalConfirmedAppointments > 0
    ? Math.round((totalCalledConfirmedAppointments / totalConfirmedAppointments) * 100)
    : 0
  const loadingPercent = status === 'loading'
    ? Math.min(96, Math.max(5, Math.round((loadingElapsedMs / averageRuntimeMs) * 100)))
    : 100
  const remainingRuntimeMs = Math.max(0, averageRuntimeMs - loadingElapsedMs)

  useEffect(() => {
    const tableScroller = tableScrollRef.current
    const topScroller = topScrollRef.current
    const topScrollContent = topScrollContentRef.current

    if (!tableScroller || !topScroller || !topScrollContent) return undefined

    topScrollContent.style.width = `${tableScroller.scrollWidth}px`

    const syncTop = () => {
      topScroller.scrollLeft = tableScroller.scrollLeft
    }
    const syncTable = () => {
      tableScroller.scrollLeft = topScroller.scrollLeft
    }

    tableScroller.addEventListener('scroll', syncTop)
    topScroller.addEventListener('scroll', syncTable)

    return () => {
      tableScroller.removeEventListener('scroll', syncTop)
      topScroller.removeEventListener('scroll', syncTable)
    }
  }, [scheduleRows.length, status])

  useEffect(() => {
    if (!notCalledDialog) return undefined

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setNotCalledDialog(null)
      }
    }

    window.addEventListener('keydown', closeOnEscape)

    return () => {
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [notCalledDialog])

  function scrollTable(direction) {
    const tableScroller = tableScrollRef.current
    const topScroller = topScrollRef.current
    const target = tableScroller || topScroller

    if (!target) return

    target.scrollBy({
      left: direction * 360,
      behavior: 'smooth',
    })
  }

  function openNotCalledDialog(title, rows) {
    setNotCalledDialog({
      title,
      rows,
    })
  }

  function closeNotCalledDialog() {
    setNotCalledDialog(null)
  }

  return (
    <section className="route-view" aria-label="Daily appointments">
      <div className="report-toolbar">
        <div>
          <h1>Daily Appointments</h1>
          <p>
            {reportWeekday} appointments
            {reportDateLabel ? ` - ${reportDateLabel}` : ''}
            {' '}
            ({timeZoneLabel})
          </p>
        </div>
        <div className="report-stats" aria-label="Report totals">
          <span>
            <strong>{scheduleRows.length}</strong>
            Appointments
          </span>
          <span>
            <strong>{report.source === 'hubspot' ? 'Live' : 'Sample'}</strong>
            Source
          </span>
        </div>
      </div>

      <div className="report-filters" aria-label="Report filters">
        <span className="filter-label">Activity date</span>
        <span className="timezone-pill">{timeZoneLabel}</span>
        <input
          aria-label="Activity date"
          className="date-filter-input"
          max="9999-12-31"
          type="date"
          value={selectedDate}
          onChange={(event) => updateSelectedDate(event.target.value)}
        />
        <button
          className="filter-button"
          type="button"
          onClick={() => updateSelectedDate(getNewYorkDate(-1))}
        >
          Yesterday
        </button>
        <button
          className="filter-button"
          type="button"
          onClick={() => updateSelectedDate(getNewYorkDate())}
        >
          Today
        </button>
      </div>

      {status === 'error' && <div className="report-alert">{error}</div>}

      {status !== 'loading' && (
        <section className="analytics-panel" aria-label="Appointment analytics">
          <div className="caller-analytics-header">
            <div>
              <h2>Appointment Analytics</h2>
                <p>Calls count when a matching outbound call is found before the appointment.</p>
            </div>
            <span>{timeZoneLabel}</span>
          </div>
          <div className="outbound-assignment-controls" aria-label="Outbound caller assignments">
            {outboundAssignmentOwners.map((ownerName) => {
              const draftCallerName = draftOutboundAssignmentOverrides[ownerName] || ownerName

              return (
                <div className="outbound-assignment-control" key={ownerName}>
                  <span>{ownerName.split(' ')[0]} team</span>
                  <select
                    aria-label={`${ownerName} outbound caller assignment`}
                    value={draftCallerName}
                    onChange={(event) => updateDraftOutboundAssignment(ownerName, event.target.value)}
                  >
                    {outboundCallerOptions.map((callerName) => (
                      <option key={callerName} value={callerName}>
                        {callerName}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
            <button
              className="outbound-assignment-fetch"
              disabled={status === 'loading'}
              type="button"
              onClick={fetchSelectedReport}
            >
              Fetch
            </button>
          </div>
          <div className="analytics-summary-grid">
            <div className="analytics-total-card appointments">
              <span>Appointments</span>
              <strong>{scheduleRows.length}</strong>
              <small>Meetings fetched for the selected timeframe</small>
              <div className="metric-rail" aria-hidden="true">
                <span style={{ width: scheduleRows.length > 0 ? '100%' : '0%' }} />
              </div>
            </div>
            <div className="analytics-total-card confirmed">
              <span>Confirmed</span>
              <strong>{totalConfirmedAppointments}</strong>
              <small>Appointments without cancellation in the meeting name</small>
              <div className="metric-rail" aria-hidden="true">
                <span style={{ width: `${confirmedRate}%` }} />
              </div>
            </div>
            <div className="analytics-total-card confirmed-called">
              <span>Confirmed Called</span>
              <strong>{totalCalledConfirmedAppointments}</strong>
              <small>Confirmed appointments called before the appointment</small>
              <div className="metric-rail" aria-hidden="true">
                <span style={{ width: `${confirmedCalledRate}%` }} />
              </div>
            </div>
          </div>
          <div className="agent-confirmed-grid" aria-label="Confirmed appointments by outbound caller and agent">
            {confirmedCallsByAgent.length === 0 && (
              <div className="agent-confirmed-empty">No confirmed appointments were called before the appointment.</div>
            )}
            {confirmedCallsByAgent.map((agent) => (
              <article className="agent-confirmed-card" key={agent.id}>
                <div className="agent-confirmed-header">
                  <h3 title={agent.callerName}>{agent.callerName}</h3>
                  <strong>
                    {agent.totalAppointments}
                    <span>
                      {' '}
                      of
                      {' '}
                      {scheduleRows.length}
                    </span>
                  </strong>
                </div>
                <div className="agent-confirmed-bar" title={`${agent.totalAppointments} of ${scheduleRows.length} appointments`}>
                  <span style={{ width: `${agent.confirmedShare}%` }} />
                </div>
                <div className="agent-assignment-table" role="table" aria-label={`${agent.callerName} appointments by agent`}>
                  <div className="agent-assignment-row heading" role="row">
                    <span role="columnheader">Agent</span>
                    <span role="columnheader">Total Appt. / Agent</span>
                    <span role="columnheader">Not Called</span>
                    <span role="columnheader">OBS</span>
                  </div>
                  {agent.meetingHosts.map((meetingHost) => (
                    <div className="agent-assignment-row" role="row" key={meetingHost.meetingHostName}>
                      <span role="cell" title={meetingHost.meetingHostName}>
                        {meetingHost.meetingHostName}
                      </span>
                      <strong role="cell">{meetingHost.totalAppointments}</strong>
                      <strong role="cell">
                        <button
                          className="not-called-count-button"
                          disabled={meetingHost.notCalled === 0}
                          type="button"
                          onClick={() => openNotCalledDialog(
                            `${meetingHost.meetingHostName} - Not Called`,
                            meetingHost.notCalledRows,
                          )}
                        >
                          {meetingHost.notCalled}
                        </button>
                      </strong>
                      <strong role="cell">-</strong>
                    </div>
                  ))}
                  <div className="agent-assignment-row total" role="row">
                    <span role="cell">Total</span>
                    <strong role="cell">{agent.totalAppointments}</strong>
                    <strong role="cell">
                      <button
                        className="not-called-count-button"
                        disabled={agent.notCalled === 0}
                        type="button"
                        onClick={() => openNotCalledDialog(
                          `${agent.callerName} meeting hosts - Not Called`,
                          agent.notCalledRows,
                        )}
                      >
                        {agent.notCalled}
                      </button>
                    </strong>
                    <strong role="cell">-</strong>
                  </div>
                </div>
              </article>
            ))}
            {juanPreviousDayCalling && (
            <article className="agent-confirmed-card previous-day-analytics" aria-label="Juan Camilo previous day calling">
              <div className="agent-confirmed-header">
                <div>
                  <h3 title={`${juanPreviousDayCalling.callerName} previous day calling`}>
                    {juanPreviousDayCalling.callerName}
                    {' '}
                    Previous Day Calling
                  </h3>
                  <p>Juan team previous-day calls for Paula Alfonso and Maria Sandoval.</p>
                </div>
                <strong>
                  {juanPreviousDayCalling.totalAppointments}
                  <span>
                    {' '}
                    of
                    {' '}
                    {scheduleRows.length}
                  </span>
                </strong>
              </div>
              <div className="agent-confirmed-bar" title={`${juanPreviousDayCalling.totalAppointments} of ${scheduleRows.length} appointments`}>
                <span style={{ width: `${juanPreviousDayCalling.confirmedShare}%` }} />
              </div>
              <div className="agent-assignment-table" role="table" aria-label="Juan Camilo previous day calling by agent">
                <div className="agent-assignment-row heading" role="row">
                  <span role="columnheader">Agent</span>
                  <span role="columnheader">Total Appt. / Agent</span>
                  <span role="columnheader">Not Called</span>
                  <span role="columnheader">OBS</span>
                </div>
                {juanPreviousDayCalling.meetingHosts.map((meetingHost) => (
                  <div className="agent-assignment-row" role="row" key={meetingHost.meetingHostName}>
                    <span role="cell" title={meetingHost.meetingHostName}>
                      {meetingHost.meetingHostName}
                    </span>
                    <strong role="cell">{meetingHost.totalAppointments}</strong>
                    <strong role="cell">
                      <button
                        className="not-called-count-button"
                        disabled={meetingHost.notCalled === 0}
                        type="button"
                        onClick={() => openNotCalledDialog(
                          `${meetingHost.meetingHostName} - Previous Day Not Called`,
                          meetingHost.notCalledRows,
                        )}
                      >
                        {meetingHost.notCalled}
                      </button>
                    </strong>
                    <strong role="cell">-</strong>
                  </div>
                ))}
                <div className="agent-assignment-row total" role="row">
                  <span role="cell">Total</span>
                  <strong role="cell">{juanPreviousDayCalling.totalAppointments}</strong>
                  <strong role="cell">
                    <button
                      className="not-called-count-button"
                      disabled={juanPreviousDayCalling.notCalled === 0}
                      type="button"
                      onClick={() => openNotCalledDialog(
                        'Juan Camilo Previous Day - Not Called',
                        juanPreviousDayCalling.notCalledRows,
                      )}
                    >
                      {juanPreviousDayCalling.notCalled}
                    </button>
                  </strong>
                  <strong role="cell">-</strong>
                </div>
              </div>
            </article>
            )}
          </div>
        </section>
      )}

      <div className="report-panel readable-report-panel">
        {status === 'loading' && (
          <div className="hubspot-loading" role="status" aria-live="polite">
            <div className="hubspot-loading-header">
              <div>
                <div className="hubspot-loading-text">Loading HubSpot appointments and outbound calls...</div>
                <div className="hubspot-loading-meta">
                  <span>Elapsed {formatDuration(loadingElapsedMs)}</span>
                  <span>Average {formatDuration(averageRuntimeMs)}</span>
                  <span>ETA {formatDuration(remainingRuntimeMs)}</span>
                </div>
              </div>
              <strong>{loadingPercent}%</strong>
            </div>
            <div
              aria-label={`Loading ${loadingPercent}%`}
              aria-valuemax="100"
              aria-valuemin="0"
              aria-valuenow={loadingPercent}
              className="hubspot-progress"
              role="progressbar"
            >
              <span style={{ width: `${loadingPercent}%` }} />
            </div>
          </div>
        )}
        <div className="hubspot-date-group">{getDateGroupLabel(report.reportDate || selectedDate)}</div>
        <div className="table-scroll-controls" aria-label="Table horizontal scroll controls">
          <button
            aria-label="Scroll table left"
            className="table-scroll-button"
            type="button"
            onClick={() => scrollTable(-1)}
          >
            ‹
          </button>
          <div className="top-table-scroll" ref={topScrollRef}>
            <div ref={topScrollContentRef} />
          </div>
          <button
            aria-label="Scroll table right"
            className="table-scroll-button"
            type="button"
            onClick={() => scrollTable(1)}
          >
            ›
          </button>
        </div>
        <div className="readable-table-shell" ref={tableScrollRef}>
          <table className="readable-report-table appointments-report-table">
            <thead>
              <tr>
                <th scope="col">Meeting Name</th>
                <th scope="col">Meeting Description</th>
                <th scope="col" aria-sort="descending">Create Date</th>
                <th scope="col">Activity Date</th>
                <th scope="col">Outbound Caller</th>
                <th scope="col">Called</th>
                <th scope="col">Confirmation</th>
              </tr>
            </thead>
            <tbody>
              {status === 'loading' && (
                <tr>
                  <td className="table-message" colSpan="7">
                    Loading HubSpot appointments and outbound calls...
                  </td>
                </tr>
              )}
              {status !== 'loading' && scheduleRows.length === 0 && (
                <tr>
                  <td className="table-message" colSpan="7">
                    No appointments found for this date.
                  </td>
                </tr>
              )}
              {status !== 'loading' && scheduleRows.map((slot) => (
                <tr key={slot.rowId}>
                  <th className="ellipsis-cell" scope="row" title={getMeetingName(slot)}>
                    {getMeetingName(slot)}
                  </th>
                  <td className="ellipsis-cell muted-report-cell" title={getMeetingDescription(slot)}>
                    {getMeetingDescription(slot) || '-'}
                  </td>
                  <td>{formatDate(slot.date)}</td>
                  <td>{formatActivityDate(slot)}</td>
                  <td className="ellipsis-cell" title={slot.callerName || ''}>
                    {slot.callerName || '-'}
                  </td>
                  <td>
                    <span
                      className={`readable-status ${slot.called === 'Called' ? 'confirmed' : 'missing'}`}
                      title={slot.calledDetail || ''}
                    >
                      {slot.called || 'Not Called'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`readable-status ${slot.confirmation === 'Confirmed' ? 'confirmed' : 'missing'}`}
                      title={slot.confirmationDetail || ''}
                    >
                      {slot.confirmation || 'Not Confirmed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {notCalledDialog && (
        <div
          aria-labelledby="not-called-dialog-title"
          aria-modal="true"
          className="report-modal-backdrop"
          role="dialog"
          onClick={closeNotCalledDialog}
        >
          <div className="report-modal" onClick={(event) => event.stopPropagation()}>
            <div className="report-modal-header">
              <div>
                <h2 id="not-called-dialog-title">{notCalledDialog.title}</h2>
                <p>
                  {notCalledDialog.rows.length}
                  {' '}
                  confirmed appointment
                  {notCalledDialog.rows.length === 1 ? '' : 's'}
                  {' '}
                  without a matching outbound call.
                </p>
              </div>
              <button
                aria-label="Close not called details"
                className="report-modal-close"
                type="button"
                onClick={closeNotCalledDialog}
              >
                x
              </button>
            </div>
            <div className="not-called-list">
              {notCalledDialog.rows.map((slot) => (
                <article className="not-called-list-item" key={slot.rowId}>
                  <strong>{slot.clientEmail || 'No email on appointment'}</strong>
                  <span>{slot.clientName || 'Unnamed client'}</span>
                  <small>
                    {formatActivityDate(slot)}
                    {' - '}
                    {slot.meetingHost || 'Unassigned'}
                  </small>
                  {slot.previousDayCalledDetail && (
                    <small>{slot.previousDayCalledDetail}</small>
                  )}
                </article>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default HubSpotCallReport

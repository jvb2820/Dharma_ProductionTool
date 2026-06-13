const agentRoster = [
  { id: 'aline', name: 'Aline', color: 'rose' },
  { id: 'arles', name: 'Arles', color: 'blue' },
  { id: 'brayam', name: 'Brayam', color: 'cyan' },
  { id: 'edmilson', name: 'Edmilson', color: 'red' },
  { id: 'maria-roa', name: 'Maria Roa', color: 'gray' },
]

const reportTimes = ['2:00 AM', '2:20 AM', '2:30 AM', '2:40 AM', '3:00 AM', '3:20 AM', '3:30 AM']
const reportTimeZone = 'America/New_York'
const sessionCachePrefix = 'hubspot-call-report'
const sessionCacheVersion = 'v5'
const defaultPollIntervalMs = 8000
const defaultMaxPollingMs = 15 * 60 * 1000

function getYesterdayDate() {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(yesterday)
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''

  return `${part('year')}-${part('month')}-${part('day')}`
}

const sampleCallRows = [
  {
    date: '2026-05-28',
    time: '2:00 AM',
    agentId: 'aline',
    clientName: 'Anayeli',
    phoneNumber: '+1 (719) 217-3625',
    callTime: '2026-05-28T02:29:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
  {
    date: '2026-05-28',
    time: '2:00 AM',
    agentId: 'arles',
    clientName: 'No appointment',
    phoneNumber: '+1 (719) 217-3625',
    callTime: '2026-05-28T02:30:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
  {
    date: '2026-05-28',
    time: '2:20 AM',
    agentId: 'edmilson',
    clientName: 'Lead callback',
    phoneNumber: '+1 (213) 555-0197',
    callTime: null,
    direction: 'OUTBOUND',
    disposition: 'NO_CALL',
  },
  {
    date: '2026-05-28',
    time: '2:40 AM',
    agentId: 'aline',
    clientName: 'Confirmed lead',
    phoneNumber: '+1 (646) 555-0182',
    callTime: '2026-05-28T02:41:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
  {
    date: '2026-05-28',
    time: '2:40 AM',
    agentId: 'arles',
    clientName: 'No appointment',
    phoneNumber: '+1 (321) 555-0148',
    callTime: '2026-05-28T02:47:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
  {
    date: '2026-05-28',
    time: '2:40 AM',
    agentId: 'edmilson',
    clientName: 'Confirmed lead',
    phoneNumber: '+1 (408) 555-0153',
    callTime: '2026-05-28T02:42:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
  {
    date: '2026-05-28',
    time: '2:40 AM',
    agentId: 'maria-roa',
    clientName: 'Not confirmed',
    phoneNumber: '+1 (702) 555-0119',
    callTime: null,
    direction: 'OUTBOUND',
    disposition: 'NO_CALL',
  },
  {
    date: '2026-05-28',
    time: '3:00 AM',
    agentId: 'aline',
    clientName: 'No appointment',
    phoneNumber: '+1 (310) 555-0194',
    callTime: '2026-05-28T03:01:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
  {
    date: '2026-05-28',
    time: '3:00 AM',
    agentId: 'brayam',
    clientName: 'Confirmed lead',
    phoneNumber: '+1 (858) 555-0121',
    callTime: '2026-05-28T03:02:00+08:00',
    direction: 'OUTBOUND',
    disposition: 'ANSWERED',
  },
]

function normalizeHubSpotCall(call) {
  const properties = call.properties ?? call
  const agentName = properties.hubspot_owner_name ?? properties.agentName ?? ''
  const matchedAgent = agentRoster.find((agent) =>
    agentName.toLowerCase().includes(agent.name.toLowerCase()),
  )

  return {
    rowId: properties.rowId ?? call.id ?? `${properties.date}|${properties.time}|${properties.agent_id}`,
    meetingName: properties.meetingName ?? properties.hs_meeting_title ?? '',
    meetingDescription: properties.meetingDescription ?? properties.hs_meeting_body ?? '',
    date: properties.report_date ?? properties.date ?? '',
    reportDate: properties.reportDate ?? '',
    time: properties.report_time ?? properties.time ?? '',
    agentId: properties.agent_id ?? matchedAgent?.id ?? '',
    agentName: properties.agentName ?? matchedAgent?.name ?? '',
    scheduledAgent: properties.scheduledAgent ?? '',
    meetingHost: properties.meetingHost ?? '',
    clientName: properties.client_name ?? properties.hs_call_title ?? 'Outbound call',
    clientEmail: properties.clientEmail ?? properties.client_email ?? properties.email ?? '',
    phoneNumber: properties.phone_number ?? properties.hs_call_to_number ?? '',
    createdAt: properties.createdAt ?? properties.createdate ?? null,
    callTime: properties.hs_timestamp ?? properties.callTime ?? null,
    callerName: properties.callerName ?? '',
    qualifyingCallers: properties.qualifyingCallers ?? [],
    previousDayCallerName: properties.previousDayCallerName ?? '',
    previousDayCallers: properties.previousDayCallers ?? [],
    previousDayCalledDetail: properties.previousDayCalledDetail ?? '',
    called: properties.called ?? '',
    calledDetail: properties.calledDetail ?? '',
    confirmation: properties.confirmation ?? '',
    confirmationDetail: properties.confirmationDetail ?? '',
    scheduledAt: properties.scheduledAt ?? null,
    direction: properties.hs_call_direction ?? properties.direction ?? '',
    disposition: properties.hs_call_disposition ?? properties.disposition ?? '',
    callOutcome: properties.callOutcome ?? '',
    callPhoneNumber: properties.callPhoneNumber ?? '',
    leewayMinutes: properties.leewayMinutes ?? null,
    leewayStatus: properties.leewayStatus ?? '',
  }
}

function getSessionCacheKey(date) {
  return `${sessionCachePrefix}:${sessionCacheVersion}:${date ?? 'default'}`
}

function readCachedReport(date) {
  try {
    const cachedValue = window.sessionStorage.getItem(getSessionCacheKey(date))

    return cachedValue ? JSON.parse(cachedValue) : null
  } catch {
    return null
  }
}

function writeCachedReport(date, report) {
  try {
    window.sessionStorage.setItem(getSessionCacheKey(date), JSON.stringify(report))
  } catch {
    // The app can still work if session storage is disabled or full.
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    window.setTimeout(resolveDelay, milliseconds)
  })
}

export function getAgentRoster() {
  return agentRoster
}

export function getReportSlots(date) {
  const reportDate = date ?? getYesterdayDate()

  return reportTimes.map((time) => ({ date: reportDate, time }))
}

export async function loadHubSpotCallReport(date, options = {}) {
  const endpoint = import.meta.env.VITE_HUBSPOT_CALL_REPORT_URL

  if (!endpoint) {
    return {
      source: 'sample',
      rows: sampleCallRows,
      reportDate: getYesterdayDate(),
      updatedAt: new Date().toISOString(),
    }
  }

  const cachedReport = options.forceRefresh ? null : readCachedReport(date)
  if (cachedReport) {
    return {
      ...cachedReport,
      source: cachedReport.source ?? 'hubspot',
      cacheSource: 'session',
    }
  }

  const startedAt = Date.now()
  let shouldForceRefresh = Boolean(options.forceRefresh)

  const buildRequestUrl = () => {
    const requestUrl = new URL(endpoint, window.location.origin)

    if (date) {
      requestUrl.searchParams.set('date', date)
    }
    if (shouldForceRefresh) {
      requestUrl.searchParams.set('refresh', '1')
    }

    return requestUrl
  }

  let payload
  let isPolling = true

  while (isPolling) {
    const requestUrl = buildRequestUrl()

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 30000)
    let response

    try {
      response = await fetch(requestUrl, {
        cache: shouldForceRefresh ? 'no-store' : 'default',
        signal: controller.signal,
      })
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('HubSpot report request timed out while checking status. Please try again in a moment.', {
          cause: error,
        })
      }

      throw error
    } finally {
      window.clearTimeout(timeoutId)
    }

    shouldForceRefresh = false

    if (response.status === 202) {
      payload = await response.json()
      const elapsedMs = Date.now() - startedAt
      const maxPollingMs = options.maxPollingMs ?? defaultMaxPollingMs

      if (elapsedMs >= maxPollingMs) {
        throw new Error('HubSpot report is still building. Please try again in a few minutes.')
      }

      await delay(payload.retryAfterMs ?? options.pollIntervalMs ?? defaultPollIntervalMs)
      continue
    }

    if (!response.ok) {
      let errorMessage = `HubSpot report request failed: ${response.status}`

      try {
        const errorPayload = await response.json()
        if (errorPayload?.message) {
          errorMessage = `${errorMessage} - ${errorPayload.message}`
        }
      } catch {
        // Keep the status-only message if the server did not return JSON.
      }

      throw new Error(errorMessage)
    }

    payload = await response.json()
    isPolling = false
  }

  if (payload?.status === 'building') {
    throw new Error('HubSpot report is still building. Please try again in a few minutes.')
  }

  const records = Array.isArray(payload) ? payload : payload.results ?? payload.rows ?? []
  const report = {
    source: 'hubspot',
    rows: records.map(normalizeHubSpotCall),
    callerAnalytics: payload.callerAnalytics ?? [],
    reportDate: payload.reportDate ?? getYesterdayDate(),
    updatedAt: payload.updatedAt ?? new Date().toISOString(),
    cacheSource: payload.cacheSource ?? 'network',
  }

  writeCachedReport(date, report)

  return report
}

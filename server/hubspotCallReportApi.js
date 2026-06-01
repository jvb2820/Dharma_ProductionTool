import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

loadLocalEnv()

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
const hubspotBaseUrl = 'https://api.hubapi.com'
const connectedDispositionId = 'f240bbac-87c9-4f6e-bf70-924b57d47db7'
const defaultAllowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173']
const reportTimeZone = process.env.HUBSPOT_REPORT_TIMEZONE ?? 'America/New_York'
const reportCache = new Map()
const reportCacheTtlMs = 5 * 60 * 1000
const inFlightReports = new Map()
const hubspotMaxAttempts = 6
const hubspotRequestSpacingMs = 700
let lastHubspotRequestAt = 0

const allowedOrigins = readAllowedOrigins()

function loadLocalEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env.local')
    const envFile = readFileSync(envPath, 'utf8')

    envFile.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return

      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex === -1) return

      const key = trimmed.slice(0, separatorIndex).trim()
      const value = trimmed.slice(separatorIndex + 1).trim()

      if (!process.env[key]) {
        process.env[key] = value
      }
    })
  } catch {
    // The API can still run with real environment variables in production.
  }
}

function readAllowedOrigins() {
  return (process.env.HUBSPOT_API_ALLOWED_ORIGINS ?? defaultAllowedOrigins.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin) {
  if (!origin) return false

  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === origin) return true
    if (allowedOrigin === '*') return true
    if (!allowedOrigin.startsWith('*.')) return false

    const allowedDomain = allowedOrigin.slice(1)
    return origin.endsWith(allowedDomain)
  })
}

function sendJson(request, response, statusCode, payload) {
  const origin = request.headers.origin
  const allowedOrigin = isAllowedOrigin(origin) ? origin : allowedOrigins[0] ?? defaultAllowedOrigins[0]

  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
  })
  response.end(JSON.stringify(payload))
}

function getZonedDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: reportTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''

  return `${part('year')}-${part('month')}-${part('day')}`
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const part = (type) => parts.find((item) => item.type === type)?.value ?? '0'
  const zonedAsUtc = Date.UTC(
    Number(part('year')),
    Number(part('month')) - 1,
    Number(part('day')),
    Number(part('hour')),
    Number(part('minute')),
    Number(part('second')),
  )

  return zonedAsUtc - date.getTime()
}

function zonedStartOfDayUtc(dateValue) {
  const utcMidnight = new Date(`${dateValue}T00:00:00Z`)
  const firstOffset = getTimeZoneOffsetMs(utcMidnight, reportTimeZone)
  const firstGuess = new Date(utcMidnight.getTime() - firstOffset)
  const finalOffset = getTimeZoneOffsetMs(firstGuess, reportTimeZone)

  return new Date(utcMidnight.getTime() - finalOffset)
}

function addDaysToIsoDate(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)

  return date.toISOString().slice(0, 10)
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function getReportDateRange(selectedDate) {
  const today = new Date()
  const reportDay = process.env.HUBSPOT_REPORT_DAY ?? 'today'
  const reportBaseDate = new Date(today)

  if (selectedDate && isIsoDate(selectedDate)) {
    reportBaseDate.setTime(zonedStartOfDayUtc(selectedDate).getTime())
  } else if (reportDay === 'yesterday') {
    reportBaseDate.setDate(today.getDate() - 1)
  }

  const reportDate = getZonedDate(reportBaseDate)
  const nextReportDate = addDaysToIsoDate(reportDate, 1)
  const fromDate = zonedStartOfDayUtc(reportDate)
  const toDate = zonedStartOfDayUtc(nextReportDate)

  return {
    reportDate,
    reportDateUs: `${reportDate.slice(5, 7)}/${reportDate.slice(8, 10)}/${reportDate.slice(0, 4)}`,
    fromMs: String(fromDate.getTime()),
    priorFromMs: String(fromDate.getTime() - 48 * 60 * 60 * 1000),
    toMs: String(toDate.getTime()),
  }
}

function displayDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(new Date(value))
}

function displayTime(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value))
}

function ownerDisplayName(owner, fallback = '') {
  return [owner?.firstName, owner?.lastName].filter(Boolean).join(' ') || owner?.email || fallback
}

function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function readPhoneFromText(value) {
  return normalizePhone(String(value ?? '').match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? '')
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function isCancelledMeeting(value) {
  return /\bcancell?ed\b|\bcancelad[ao]\b|\bcancel/i.test(String(value ?? ''))
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+\n/g, '\n')
    .trim()
}

function readBodyField(text, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escapedLabel}\\s*:?\\s*([^\\n]+)`, 'i')
  return text.match(pattern)?.[1]?.trim() ?? ''
}

function parseMeetingBody(body) {
  const text = stripHtml(body)

  return {
    clientName: readBodyField(text, 'Name'),
    clientEmail: readBodyField(text, 'Email'),
    phoneNumber: readBodyField(text, 'Phone'),
    scheduledAgent: readBodyField(text, 'Agent Lead Management') || readBodyField(text, 'Agent'),
  }
}

async function hubspotFetch(path, options = {}) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN
  if (!token) {
    throw new Error('Missing HUBSPOT_PRIVATE_APP_TOKEN')
  }

  for (let attempt = 1; attempt <= hubspotMaxAttempts; attempt += 1) {
    await waitForHubspotSlot()

    const response = await fetch(`${hubspotBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })

    if (response.ok) {
      return response.json()
    }

    const body = await response.text()

    if (response.status !== 429 || attempt === hubspotMaxAttempts) {
      throw new Error(`HubSpot request failed (${response.status}): ${body}`)
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    const retryDelayMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : attempt * 2500

    await delay(retryDelayMs)
  }
}

async function waitForHubspotSlot() {
  const elapsedMs = Date.now() - lastHubspotRequestAt
  const waitMs = Math.max(0, hubspotRequestSpacingMs - elapsedMs)

  if (waitMs > 0) {
    await delay(waitMs)
  }

  lastHubspotRequestAt = Date.now()
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}

async function hubspotSearch(objectType, body) {
  const rows = []
  let after

  do {
    const payload = await hubspotFetch(`/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      body: {
        ...body,
        after,
      },
    })

    rows.push(...(payload.results ?? []))
    after = payload.paging?.next?.after
  } while (after)

  return rows
}

async function loadOwners() {
  const payload = await hubspotFetch('/crm/v3/owners?limit=100&archived=false')

  return new Map((payload.results ?? []).map((owner) => [String(owner.id), owner]))
}

async function loadScheduledContactsForDate(selectedDate) {
  const range = getReportDateRange(selectedDate)
  const rows = await hubspotSearch('meetings', {
    filterGroups: [
      {
        filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: range.fromMs },
          { propertyName: 'hs_timestamp', operator: 'LT', value: range.toMs },
        ],
      },
    ],
    properties: [
      'hs_timestamp',
      'hs_meeting_start_time',
      'hs_meeting_end_time',
      'hs_meeting_title',
      'hs_meeting_body',
      'hs_meeting_outcome',
      'createdate',
      'hubspot_owner_id',
    ],
    limit: 100,
    sorts: ['hs_timestamp'],
  })

  return {
    reportDate: range.reportDate,
    rows,
  }
}

async function loadOutboundCallsForDate(selectedDate) {
  const range = getReportDateRange(selectedDate)
  const rows = await hubspotSearch('calls', {
    filterGroups: [
      {
        filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: range.priorFromMs },
          { propertyName: 'hs_timestamp', operator: 'LT', value: range.toMs },
          { propertyName: 'hs_call_direction', operator: 'EQ', value: 'OUTBOUND' },
        ],
      },
    ],
    properties: [
      'hs_timestamp',
      'hs_call_direction',
      'hs_call_disposition',
      'hs_call_status',
      'hs_call_to_number',
      'hs_call_title',
      'hubspot_owner_id',
    ],
    limit: 100,
    sorts: ['hs_timestamp'],
  })

  return rows
}

function normalizeCall(call, owners) {
  const properties = call.properties ?? {}
  const ownerId = properties.hubspot_owner_id ?? ''
  const owner = owners.get(String(ownerId))

  return {
    callId: call.id,
    callerName: ownerDisplayName(owner, ownerId),
    callTime: properties.hs_timestamp,
    callTitle: properties.hs_call_title ?? '',
    phoneNumber: normalizePhone(properties.hs_call_to_number) || readPhoneFromText(properties.hs_call_title),
    disposition:
      properties.hs_call_disposition === connectedDispositionId
        ? 'CONNECTED'
        : properties.hs_call_status ?? properties.hs_call_disposition ?? '',
  }
}

function matchesMeeting(call, meeting) {
  const meetingPhone = normalizePhone(meeting.phoneNumber)

  if (call.phoneNumber && meetingPhone) {
    return call.phoneNumber.endsWith(meetingPhone.slice(-10))
  }

  const clientName = normalizeText(meeting.clientName)
  const callTitle = normalizeText(call.callTitle)

  return clientName.length > 4 && callTitle.includes(clientName)
}

function findPriorOutboundCall(meeting, calls) {
  const scheduledAt = new Date(meeting.scheduledAt)

  return calls
    .filter((call) => {
      if (!call.callTime || Number.isNaN(scheduledAt.getTime())) return false
      const minutesBeforeAppointment = Math.round(
        (scheduledAt.getTime() - new Date(call.callTime).getTime()) / 60000,
      )

      if (minutesBeforeAppointment <= 0) return false

      return matchesMeeting(call, meeting)
    })
    .sort((left, right) => {
      const leftConnected = left.disposition === 'CONNECTED' ? 1 : 0
      const rightConnected = right.disposition === 'CONNECTED' ? 1 : 0

      if (leftConnected !== rightConnected) return rightConnected - leftConnected

      return new Date(right.callTime) - new Date(left.callTime)
    })[0]
}

function buildCallerAnalytics(rows) {
  const callerRows = rows.reduce((lookup, row) => {
    if (!row.callerName || row.called !== 'Called') return lookup

    const callerName = row.callerName
    const current = lookup.get(callerName) ?? {
      callerName,
      called: 0,
      confirmed: 0,
    }

    current.called += 1
    if (row.confirmation === 'Confirmed') {
      current.confirmed += 1
    }

    lookup.set(callerName, current)
    return lookup
  }, new Map())

  return [...callerRows.values()].sort((left, right) => right.called - left.called)
}

async function buildCallReport(selectedDate) {
  const owners = await loadOwners()
  const scheduleResult = await loadScheduledContactsForDate(selectedDate)
  const outboundCalls = await loadOutboundCallsForDate(selectedDate)
  const calls = outboundCalls.map((call) => normalizeCall(call, owners))
  const rows = scheduleResult.rows
    .map((meeting) => {
      const properties = meeting.properties ?? {}
      const meetingDetails = parseMeetingBody(properties.hs_meeting_body)
      const scheduledAt = new Date(
        properties.hs_meeting_start_time ?? properties.hs_timestamp,
      )
      const createdAt = properties.createdate ? new Date(properties.createdate) : scheduledAt

      const row = {
        rowId: meeting.id,
        meetingName: properties.hs_meeting_title || 'Meeting',
        meetingDescription: stripHtml(properties.hs_meeting_body),
        date: displayDate(createdAt),
        reportDate: scheduleResult.reportDate,
        time: displayTime(scheduledAt),
        createdAt: createdAt?.toISOString() ?? null,
        scheduledAt: scheduledAt?.toISOString() ?? null,
        scheduledAgent: meetingDetails.scheduledAgent,
        clientName: meetingDetails.clientName || properties.hs_meeting_title || 'Meeting',
        clientEmail: meetingDetails.clientEmail,
        phoneNumber: meetingDetails.phoneNumber,
      }
      const matchingCall = findPriorOutboundCall(row, calls)
      const appointmentCancelled = isCancelledMeeting(row.meetingName)

      return {
        ...row,
        callerName: matchingCall?.callerName ?? '',
        called: matchingCall ? 'Called' : 'Not Called',
        calledDetail: matchingCall
          ? `${matchingCall.disposition || 'Outbound call'} at ${displayTime(matchingCall.callTime)}`
          : 'No prior outbound call found',
        confirmation: appointmentCancelled ? 'Not Confirmed' : 'Confirmed',
        confirmationDetail: appointmentCancelled
          ? 'Meeting name indicates the appointment was cancelled'
          : 'Meeting name does not indicate cancellation',
        callTime: matchingCall?.callTime ?? null,
      }
    })
    .sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt))

  return {
    reportDate: scheduleResult.reportDate,
    rows,
    callerAnalytics: buildCallerAnalytics(rows),
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(request, response, 204, {})
    return
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host}`)

  if (requestUrl.pathname === '/health' && request.method === 'GET') {
    sendJson(request, response, 200, {
      status: 'ok',
      service: 'hubspot-call-report-api',
    })
    return
  }

  if (requestUrl.pathname === '/api/hubspot/call-report' && request.method === 'GET') {
    const selectedDate = requestUrl.searchParams.get('date')
    const cacheKey = selectedDate || 'default'
    const cachedReport = reportCache.get(cacheKey)

    if (cachedReport && Date.now() - cachedReport.cachedAt < reportCacheTtlMs) {
      sendJson(request, response, 200, cachedReport.payload)
      return
    }

    let reportPromise = inFlightReports.get(cacheKey)

    if (!reportPromise) {
      reportPromise = buildCallReport(selectedDate)
      inFlightReports.set(cacheKey, reportPromise)
    }

    try {
      const report = await reportPromise
      const payload = {
        source: 'hubspot',
        updatedAt: new Date().toISOString(),
        reportDate: report.reportDate,
        rows: report.rows,
        callerAnalytics: report.callerAnalytics,
      }

      reportCache.set(cacheKey, {
        cachedAt: Date.now(),
        payload,
      })
      sendJson(request, response, 200, payload)
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      })
    } finally {
      inFlightReports.delete(cacheKey)
    }
    return
  }

  sendJson(request, response, 404, {
    message: 'Not found',
  })
})

server.listen(port, host, () => {
  console.log(`HubSpot call report API listening on http://${host}:${port}`)
})

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

loadLocalEnv()

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
const hubspotBaseUrl = 'https://api.hubapi.com'
const shopifyApiVersion = process.env.SHOPIFY_API_VERSION ?? '2026-01'
const defaultShopifyStatusSheetCsvUrl = 'https://docs.google.com/spreadsheets/d/1uBJLgzyYtBnPxR9x-DuHRcJz1DTJm3YSK7halebtWLg/gviz/tq?tqx=out:csv&gid=608356906'
const supabaseTrackingTable = process.env.SUPABASE_TRACKING_TABLE ?? 'tracking_dashboard'
const excludedTrackingOrderNumbers = readExcludedTrackingOrderNumbers()
const overdueBusinessDaysThreshold = 5
const connectedDispositionId = 'f240bbac-87c9-4f6e-bf70-924b57d47db7'
const defaultAllowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173']
const reportTimeZone = process.env.HUBSPOT_REPORT_TIMEZONE ?? 'America/New_York'
const reportCache = new Map()
const trackingCache = new Map()
const uspsTrackingCache = new Map()
let sheetStatusCache = null
const currentDateCacheTtlMs = 5 * 60 * 1000
const pastDateCacheTtlMs = 24 * 60 * 60 * 1000
const callReportCacheVersion = 'contact-call-v1'
const inFlightReports = new Map()
const inFlightTrackingReports = new Map()
const hubspotMaxAttempts = 6
const hubspotRequestSpacingMs = 700
const uspsTrackingCacheTtlMs = 30 * 60 * 1000
const shopifyAccessTokenRefreshBufferMs = 5 * 60 * 1000
let lastHubspotRequestAt = 0
let shopifyAccessTokenCache = null
let shopifyAccessTokenRequest = null

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

function getReportCacheTtlMs(reportDate) {
  return reportDate === getZonedDate(new Date()) ? currentDateCacheTtlMs : pastDateCacheTtlMs
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

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

function normalizeMatchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeTrackingOrderKey(value) {
  return String(value ?? '').replace(/\s+/g, '').trim().toLowerCase()
}

function readExcludedTrackingOrderNumbers() {
  const configuredValue = process.env.SHOPIFY_TRACKING_EXCLUDED_ORDERS ?? 'cb_test_order'

  return new Set(
    configuredValue
      .split(',')
      .map(normalizeTrackingOrderKey)
      .filter(Boolean),
  )
}

function isExcludedTrackingOrder(row) {
  return excludedTrackingOrderNumbers.has(normalizeTrackingOrderKey(row?.orderNumber ?? row?.order_number))
}

function filterExcludedTrackingOrders(rows) {
  return rows.filter((row) => !isExcludedTrackingOrder(row))
}

function chunkArray(values, size) {
  const chunks = []

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }

  return chunks
}

function normalizeOrderNumber(value) {
  const cleaned = String(value ?? '').replace(/\s+/g, '').trim()

  return cleaned.startsWith('#') ? cleaned : `#${cleaned.replace(/^#/, '')}`
}

function normalizeTrackingNumber(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function isOriginalDetoxTeaItem(value) {
  return normalizeMatchText(value).includes('detox tea')
}

function parseDisplayDate(value) {
  if (!value) return null

  const parts = String(value).trim().split('/').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null

  const [month, day, year] = parts
  const date = new Date(Date.UTC(year, month - 1, day, 12))

  return Number.isNaN(date.getTime()) ? null : date
}

function displayDateToIso(value) {
  const date = parseDisplayDate(value)

  return date ? date.toISOString().slice(0, 10) : null
}

function isoDateToDisplay(value) {
  if (!value) return ''

  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(date)
}

function countTrackingBusinessDays(startDate, endDate = new Date()) {
  if (!startDate) return 0

  const current = new Date(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
  let businessDays = 0

  current.setDate(current.getDate() + 1)

  while (current <= end) {
    const day = current.getDay()

    if (day !== 0 && day !== 6) {
      businessDays += 1
    }
    current.setDate(current.getDate() + 1)
  }

  return businessDays
}

function isDeliveredStatus(value) {
  return String(value ?? '').toLowerCase().includes('delivered')
    && !String(value ?? '').toLowerCase().includes('failed')
}

function readOrderSort(value) {
  const match = String(value ?? '').match(/\d+/)

  return match ? Number(match[0]) : null
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim()
}

function readXmlTag(xml, tagName) {
  const match = String(xml ?? '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'))

  return decodeXml(match?.[1] ?? '')
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

function cleanMeetingPersonName(value) {
  return String(value ?? '')
    .split(/\s+\|\s+|\s+Organized by\b/i)[0]
    .replace(/^by\s+/i, '')
    .trim()
}

function readMeetingHost(text, title) {
  const bodyHost = cleanMeetingPersonName(readBodyField(text, 'Hosted by'))

  if (bodyHost) return bodyHost

  const titleHost = String(title ?? '').match(/\bhosted by\s+(.+?)(?:\s+with\b|$)/i)?.[1]

  return cleanMeetingPersonName(titleHost)
}

function parseMeetingBody(body, title = '') {
  const text = stripHtml(body)

  return {
    clientName: readBodyField(text, 'Name'),
    clientEmail: readBodyField(text, 'Email'),
    phoneNumber: readBodyField(text, 'Phone'),
    scheduledAgent: readBodyField(text, 'Agent Lead Management') || readBodyField(text, 'Agent'),
    meetingHost: readMeetingHost(text, title),
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

function normalizeShopifyStoreDomain(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
}

function hasShopifyClientCredentials() {
  return Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)
}

async function requestShopifyAccessToken(storeDomain) {
  const response = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Shopify token request failed (${response.status}): ${body}`)
  }

  const payload = await response.json()
  const accessToken = payload.access_token
  const expiresInSeconds = Number(payload.expires_in)

  if (!accessToken) {
    throw new Error('Shopify token request did not return an access token')
  }

  return {
    accessToken,
    expiresAt: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? Date.now() + (expiresInSeconds * 1000)
      : Date.now() + (24 * 60 * 60 * 1000),
  }
}

async function getShopifyAccessToken(storeDomain, options = {}) {
  const fallbackToken = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? '').trim()

  if (!hasShopifyClientCredentials()) {
    if (fallbackToken) return fallbackToken

    throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET')
  }

  if (
    !options.forceRefresh
    && shopifyAccessTokenCache
    && Date.now() < shopifyAccessTokenCache.expiresAt - shopifyAccessTokenRefreshBufferMs
  ) {
    return shopifyAccessTokenCache.accessToken
  }

  if (!options.forceRefresh && shopifyAccessTokenRequest) {
    return shopifyAccessTokenRequest
  }

  shopifyAccessTokenRequest = requestShopifyAccessToken(storeDomain)
    .then((tokenPayload) => {
      shopifyAccessTokenCache = tokenPayload
      return tokenPayload.accessToken
    })
    .catch((error) => {
      if (fallbackToken && !options.forceRefresh) {
        return fallbackToken
      }

      throw error
    })
    .finally(() => {
      shopifyAccessTokenRequest = null
    })

  return shopifyAccessTokenRequest
}

function encodeShopifyParams(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

function readShopifyNextPageInfo(linkHeader) {
  return String(linkHeader ?? '')
    .split(',')
    .map((link) => link.trim())
    .find((link) => link.includes('rel="next"'))
    ?.match(/[?&]page_info=([^&>]+)/)?.[1]
}

function getSupabaseRestUrl() {
  const restUrl = String(process.env.SUPABASE_REST_URL ?? '').trim()

  return restUrl ? restUrl.replace(/\/+$/, '') : ''
}

function hasSupabaseConfig() {
  return Boolean(getSupabaseRestUrl() && process.env.SUPABASE_ANON_KEY)
}

async function supabaseRequest(path, options = {}) {
  const restUrl = getSupabaseRestUrl()
  const anonKey = process.env.SUPABASE_ANON_KEY

  if (!restUrl || !anonKey) {
    throw new Error('Missing SUPABASE_REST_URL or SUPABASE_ANON_KEY')
  }

  const response = await fetch(`${restUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Supabase request failed (${response.status}): ${body}`)
  }

  if (response.status === 204) return null

  const text = await response.text()

  return text ? JSON.parse(text) : null
}

function buildTrackingDatabaseRow(row, sourceUpdatedAt) {
  const orderDate = displayDateToIso(row.date)
  const shippedDate = displayDateToIso(row.dateShipped)
  const deliveryDate = displayDateToIso(row.deliveryDate)
  const ageStartDate = parseDisplayDate(row.dateShipped || row.date)
  const delivered = isDeliveredStatus(row.status)
  const businessDaysOpen = delivered ? 0 : countTrackingBusinessDays(ageStartDate)

  return {
    row_id: String(row.rowId ?? `${row.orderNumber}|${row.item}|${row.tracking}`),
    order_number: row.orderNumber ?? '',
    order_sort: readOrderSort(row.orderNumber),
    supliful_order: row.suplifulOrder || null,
    item: row.item || null,
    customer_name: row.name || null,
    phone: row.phone || null,
    order_date: orderDate,
    date_shipped: shippedDate,
    tracking_number: row.tracking || null,
    usps_url: row.uspsUrl || null,
    delivery_date: deliveryDate,
    status: row.status || null,
    status_source: row.statusSource || null,
    business_days_open: businessDaysOpen,
    is_overdue: !delivered && businessDaysOpen > overdueBusinessDaysThreshold,
    observation: row.observation || null,
    raw_data: row,
    source_updated_at: sourceUpdatedAt,
    synced_at: new Date().toISOString(),
  }
}

function normalizeTrackingDatabaseRow(row) {
  return {
    rowId: row.row_id,
    orderNumber: row.order_number ?? '',
    suplifulOrder: row.supliful_order ?? '',
    item: row.item ?? '',
    name: row.customer_name ?? '',
    phone: row.phone ?? '',
    date: isoDateToDisplay(row.order_date),
    dateShipped: isoDateToDisplay(row.date_shipped),
    tracking: row.tracking_number ?? '',
    uspsUrl: row.usps_url ?? '',
    deliveryDate: isoDateToDisplay(row.delivery_date),
    status: row.status ?? '',
    statusSource: row.status_source ?? '',
    observation: row.observation ?? '',
    businessDaysOpen: row.business_days_open ?? 0,
    isOverdue: Boolean(row.is_overdue),
    sourceUpdatedAt: row.source_updated_at ?? null,
    syncedAt: row.synced_at ?? null,
  }
}

async function upsertTrackingRowsToSupabase(rows, sourceUpdatedAt) {
  if (!hasSupabaseConfig() || rows.length === 0) return false

  const databaseRows = filterExcludedTrackingOrders(rows)
    .map((row) => buildTrackingDatabaseRow(row, sourceUpdatedAt))

  if (databaseRows.length === 0) return false

  for (let index = 0; index < databaseRows.length; index += 500) {
    const batch = databaseRows.slice(index, index + 500)

    await supabaseRequest(`/${supabaseTrackingTable}?on_conflict=row_id`, {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: batch,
    })
  }

  return true
}

async function loadTrackingRowsFromSupabase() {
  if (!hasSupabaseConfig()) return []

  const params = new URLSearchParams({
    select: '*',
    order: 'order_sort.asc,row_id.asc',
  })
  const rows = await supabaseRequest(`/${supabaseTrackingTable}?${params.toString()}`)

  return Array.isArray(rows) ? filterExcludedTrackingOrders(rows).map(normalizeTrackingDatabaseRow) : []
}

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let insideQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const nextChar = text[index + 1]

    if (insideQuotes && char === '"' && nextChar === '"') {
      value += '"'
      index += 1
      continue
    }

    if (char === '"') {
      insideQuotes = !insideQuotes
      continue
    }

    if (!insideQuotes && char === ',') {
      row.push(value)
      value = ''
      continue
    }

    if (!insideQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && nextChar === '\n') {
        index += 1
      }
      row.push(value)
      rows.push(row)
      row = []
      value = ''
      continue
    }

    value += char
  }

  row.push(value)
  rows.push(row)

  const headers = rows.shift()?.map((header) => header.trim()) ?? []

  return rows
    .filter((csvRow) => csvRow.some((cell) => String(cell ?? '').trim()))
    .map((csvRow) => headers.reduce((record, header, index) => {
      record[header] = String(csvRow[index] ?? '').replace(/[\r\n]+/g, ' ').trim()
      return record
    }, {}))
}

function readSheetCell(row, header) {
  return row[header] ?? row[header.toLowerCase()] ?? ''
}

function buildSheetStatusLookup(rows) {
  return rows.reduce((lookup, row) => {
    const status = readSheetCell(row, 'Status').trim()
    if (!status) return lookup

    const orderNumber = normalizeOrderNumber(readSheetCell(row, 'Order Number'))
    const item = normalizeMatchText(readSheetCell(row, 'Item'))
    const tracking = normalizeTrackingNumber(readSheetCell(row, 'Tracking'))
    const deliveryDate = readSheetCell(row, 'Delivery Date')
    const observation = readSheetCell(row, 'Observation')
    const sheetStatus = {
      status,
      deliveryDate,
      observation,
    }

    if (tracking) {
      lookup.byTracking.set(tracking, sheetStatus)
    }
    if (orderNumber && item) {
      lookup.byOrderItem.set(`${orderNumber}|${item}`, sheetStatus)
    }
    if (orderNumber && status && !lookup.byOrder.has(orderNumber)) {
      lookup.byOrder.set(orderNumber, sheetStatus)
    }

    return lookup
  }, {
    byTracking: new Map(),
    byOrderItem: new Map(),
    byOrder: new Map(),
  })
}

async function loadSheetStatusLookup(forceRefresh = false) {
  const sheetCsvUrl = process.env.SHOPIFY_TRACKING_STATUS_SHEET_CSV_URL ?? defaultShopifyStatusSheetCsvUrl

  if (!sheetCsvUrl) {
    return buildSheetStatusLookup([])
  }

  if (!forceRefresh && sheetStatusCache && Date.now() - sheetStatusCache.cachedAt < currentDateCacheTtlMs) {
    return sheetStatusCache.lookup
  }

  const response = await fetch(sheetCsvUrl)
  if (!response.ok) {
    throw new Error(`Google Sheet status request failed (${response.status})`)
  }

  const rows = parseCsv(await response.text())
  const lookup = buildSheetStatusLookup(rows)

  sheetStatusCache = {
    cachedAt: Date.now(),
    lookup,
    rowCount: rows.length,
  }

  return lookup
}

async function shopifyFetch(path, params = {}) {
  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_DOMAIN)

  if (!storeDomain) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN')
  }

  const queryString = encodeShopifyParams(params)
  const url = `https://${storeDomain}/admin/api/${shopifyApiVersion}${path}${queryString ? `?${queryString}` : ''}`
  const fetchWithToken = async (token) => fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
  })

  const token = await getShopifyAccessToken(storeDomain)
  let response = await fetchWithToken(token)

  if (response.status === 401 || response.status === 403) {
    const refreshedToken = await getShopifyAccessToken(storeDomain, { forceRefresh: true })

    if (refreshedToken !== token) {
      response = await fetchWithToken(refreshedToken)
    }
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Shopify request failed (${response.status}): ${body}`)
  }

  return {
    payload: await response.json(),
    nextPageInfo: readShopifyNextPageInfo(response.headers.get('link')),
  }
}

function getUspsTrackingUrl(trackingNumber) {
  const normalizedTrackingNumber = normalizeTrackingNumber(trackingNumber)

  return normalizedTrackingNumber
    ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(normalizedTrackingNumber)}`
    : ''
}

function normalizeUspsDashboardStatus(summary, event) {
  const text = normalizeMatchText(`${event} ${summary}`)

  if (text.includes('delivered')) return 'Delivered'
  if (
    text.includes('failed')
    || text.includes('delivery attempt')
    || text.includes('notice left')
    || text.includes('undeliverable')
    || text.includes('return to sender')
    || text.includes('insufficient address')
  ) {
    return 'Failed delivery'
  }
  if (
    text.includes('in transit')
    || text.includes('arrived')
    || text.includes('departed')
    || text.includes('out for delivery')
    || text.includes('accepted')
    || text.includes('processed')
    || text.includes('moving')
  ) {
    return 'In transit'
  }
  if (
    text.includes('label created')
    || text.includes('pre shipment')
    || text.includes('shipping partner')
    || text.includes('awaiting item')
  ) {
    return 'In progress'
  }

  return event || summary ? 'In progress' : ''
}

function parseUspsDate(value) {
  const dateText = String(value ?? '').trim()
  if (!dateText) return ''

  const date = new Date(dateText)
  if (Number.isNaN(date.getTime())) return dateText

  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function parseUspsTrackResponse(xml) {
  const lookup = new Map()
  const trackInfoPattern = /<TrackInfo\b([^>]*)>([\s\S]*?)<\/TrackInfo>/gi
  let match

  while ((match = trackInfoPattern.exec(xml))) {
    const id = normalizeTrackingNumber(match[1].match(/\bID="([^"]+)"/i)?.[1] ?? '')
    const body = match[2]
    const errorDescription = readXmlTag(body, 'Description')
    const event = readXmlTag(body, 'Event')
    const eventDate = readXmlTag(body, 'EventDate')
    const eventTime = readXmlTag(body, 'EventTime')
    const eventCity = readXmlTag(body, 'EventCity')
    const eventState = readXmlTag(body, 'EventState')
    const summary = readXmlTag(body, 'TrackSummary') || [event, eventCity, eventState].filter(Boolean).join(', ')
    const status = errorDescription
      ? ''
      : normalizeUspsDashboardStatus(summary, event)

    if (!id) continue

    lookup.set(id, {
      status,
      deliveryDate: status === 'Delivered' ? parseUspsDate(eventDate) : '',
      observation: summary,
      uspsEvent: event,
      uspsEventDate: eventDate,
      uspsEventTime: eventTime,
      uspsError: errorDescription,
    })
  }

  return lookup
}

async function loadUspsTrackingStatuses(trackingNumbers) {
  const userId = process.env.USPS_WEBTOOLS_USER_ID
  const enabled = process.env.USPS_TRACKING_ENABLED !== '0'
  const normalizedTrackingNumbers = [...new Set(trackingNumbers.map(normalizeTrackingNumber).filter(Boolean))]

  if (!enabled || !userId || normalizedTrackingNumbers.length === 0) {
    return new Map()
  }

  const lookup = new Map()
  const numbersToFetch = []

  normalizedTrackingNumbers.forEach((trackingNumber) => {
    const cachedStatus = uspsTrackingCache.get(trackingNumber)

    if (cachedStatus && Date.now() - cachedStatus.cachedAt < uspsTrackingCacheTtlMs) {
      lookup.set(trackingNumber, cachedStatus.payload)
      return
    }

    numbersToFetch.push(trackingNumber)
  })

  for (let index = 0; index < numbersToFetch.length; index += 35) {
    const batch = numbersToFetch.slice(index, index + 35)
    const trackIds = batch
      .map((trackingNumber) => `<TrackID ID="${escapeXml(trackingNumber)}"></TrackID>`)
      .join('')
    const xml = `<TrackRequest USERID="${escapeXml(userId)}">${trackIds}</TrackRequest>`
    const requestUrl = `https://secure.shippingapis.com/ShippingAPI.dll?API=TrackV2&XML=${encodeURIComponent(xml)}`
    const response = await fetch(requestUrl)

    if (!response.ok) {
      throw new Error(`USPS tracking request failed (${response.status})`)
    }

    const batchLookup = parseUspsTrackResponse(await response.text())

    batchLookup.forEach((payload, trackingNumber) => {
      uspsTrackingCache.set(trackingNumber, {
        cachedAt: Date.now(),
        payload,
      })
      lookup.set(trackingNumber, payload)
    })
  }

  return lookup
}

function formatShopifyDate(value) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(date)
}

function readOrderName(order) {
  const shippingAddress = order.shipping_address ?? {}
  const billingAddress = order.billing_address ?? {}
  const customer = order.customer ?? {}
  const firstName = shippingAddress.first_name ?? billingAddress.first_name ?? customer.first_name ?? ''
  const lastName = shippingAddress.last_name ?? billingAddress.last_name ?? customer.last_name ?? ''

  return [firstName, lastName].filter(Boolean).join(' ') || order.email || ''
}

function readOrderPhone(order) {
  return order.shipping_address?.phone
    ?? order.billing_address?.phone
    ?? order.phone
    ?? order.customer?.phone
    ?? ''
}

function readOrderItems(order) {
  return (order.line_items ?? [])
    .map((item) => item.name || item.title)
    .filter(Boolean)
    .join(', ')
}

function readLineItemProperty(lineItem, propertyNames) {
  const properties = lineItem.properties ?? []
  const matchingProperty = properties.find((property) =>
    propertyNames.some((propertyName) =>
      String(property.name ?? '').toLowerCase().includes(propertyName),
    ),
  )

  return matchingProperty?.value ?? ''
}

function readTrackingNumbers(order) {
  const trackingNumbers = (order.fulfillments ?? []).flatMap((fulfillment) => {
    if (Array.isArray(fulfillment.tracking_numbers) && fulfillment.tracking_numbers.length > 0) {
      return fulfillment.tracking_numbers
    }

    return fulfillment.tracking_number ? [fulfillment.tracking_number] : []
  })

  return [...new Set(trackingNumbers.filter(Boolean))].join(', ')
}

function readLineItemFulfillments(order, lineItem) {
  const matchingFulfillments = (order.fulfillments ?? []).filter((fulfillment) =>
    (fulfillment.line_items ?? []).some((fulfillmentLineItem) =>
      String(fulfillmentLineItem.id) === String(lineItem.id)
      || String(fulfillmentLineItem.variant_id) === String(lineItem.variant_id),
    ),
  )

  return matchingFulfillments.length > 0 ? matchingFulfillments : order.fulfillments ?? []
}

function readTrackingNumbersFromFulfillments(fulfillments) {
  const trackingNumbers = fulfillments.flatMap((fulfillment) => {
    if (Array.isArray(fulfillment.tracking_numbers) && fulfillment.tracking_numbers.length > 0) {
      return fulfillment.tracking_numbers
    }

    return fulfillment.tracking_number ? [fulfillment.tracking_number] : []
  })

  return [...new Set(trackingNumbers.filter(Boolean))].join(', ')
}

function readShippedDateFromFulfillments(fulfillments) {
  const fulfillmentDates = fulfillments
    .map((fulfillment) => fulfillment.created_at ?? fulfillment.updated_at)
    .filter(Boolean)
    .sort((left, right) => new Date(right) - new Date(left))

  return formatShopifyDate(fulfillmentDates[0])
}

function mapShopifyShipmentStatus(value) {
  const shipmentStatus = String(value ?? '').toLowerCase()

  if (shipmentStatus === 'delivered') return 'Delivered'
  if (
    shipmentStatus === 'failure'
    || shipmentStatus === 'attempted_delivery'
  ) {
    return 'Failed delivery'
  }
  if (
    shipmentStatus === 'in_transit'
    || shipmentStatus === 'out_for_delivery'
  ) {
    return 'In transit'
  }
  if (
    shipmentStatus === 'confirmed'
    || shipmentStatus === 'label_printed'
    || shipmentStatus === 'label_purchased'
    || shipmentStatus === 'ready_for_pickup'
  ) {
    return 'In progress'
  }

  return ''
}

function readShopifyShipmentStatusFromFulfillments(fulfillments) {
  const statuses = fulfillments
    .map((fulfillment) => mapShopifyShipmentStatus(fulfillment.shipment_status))
    .filter(Boolean)

  if (statuses.includes('Failed delivery')) return 'Failed delivery'
  if (statuses.includes('Delivered')) return 'Delivered'
  if (statuses.includes('In transit')) return 'In transit'
  if (statuses.includes('In progress')) return 'In progress'

  return ''
}

function readDeliveredDateFromFulfillments(fulfillments) {
  const deliveredDate = fulfillments
    .filter((fulfillment) => mapShopifyShipmentStatus(fulfillment.shipment_status) === 'Delivered')
    .map((fulfillment) => fulfillment.delivered_at ?? fulfillment.updated_at)
    .filter(Boolean)
    .sort((left, right) => new Date(right) - new Date(left))[0]

  return formatShopifyDate(deliveredDate)
}

function readShopifyStatusObservation(fulfillments) {
  const shipmentStatuses = [...new Set(fulfillments
    .map((fulfillment) => fulfillment.shipment_status)
    .filter(Boolean))]

  return shipmentStatuses.length > 0
    ? `Shopify shipment status: ${shipmentStatuses.join(', ')}`
    : ''
}

function hasShopifyShippingConfirmation(fulfillments) {
  return fulfillments.some((fulfillment) =>
    String(fulfillment.status ?? '').toLowerCase() === 'success',
  )
}

function normalizeShopifyOrder(order) {
  const tracking = readTrackingNumbers(order)
  const fulfillments = order.fulfillments ?? []
  const shopifyStatus = readShopifyShipmentStatusFromFulfillments(fulfillments)

  return {
    rowId: String(order.id),
    orderNumber: order.name ?? String(order.order_number ?? order.id),
    item: readOrderItems(order),
    name: readOrderName(order),
    phone: readOrderPhone(order),
    date: formatShopifyDate(order.created_at),
    dateShipped: readShippedDateFromFulfillments(fulfillments),
    tracking,
    uspsUrl: getUspsTrackingUrl(tracking),
    deliveryDate: shopifyStatus === 'Delivered' ? readDeliveredDateFromFulfillments(fulfillments) : '',
    status: shopifyStatus,
    statusSource: shopifyStatus ? 'shopify' : '',
    observation: shopifyStatus ? readShopifyStatusObservation(fulfillments) : '',
    shopifyShippingConfirmation: hasShopifyShippingConfirmation(fulfillments),
  }
}

function normalizeShopifyOrderLine(order, lineItem, lineItemIndex) {
  const fulfillments = readLineItemFulfillments(order, lineItem)
  const tracking = readTrackingNumbersFromFulfillments(fulfillments)
  const shopifyStatus = readShopifyShipmentStatusFromFulfillments(fulfillments)

  return {
    rowId: `${order.id}:${lineItem.id ?? lineItemIndex}`,
    orderNumber: order.name ?? String(order.order_number ?? order.id),
    suplifulOrder: readLineItemProperty(lineItem, ['supliful', 'fulfillment order', 'order id']),
    item: lineItem.name || lineItem.title || '',
    name: readOrderName(order),
    phone: readOrderPhone(order),
    date: formatShopifyDate(order.created_at),
    dateShipped: readShippedDateFromFulfillments(fulfillments),
    tracking,
    uspsUrl: getUspsTrackingUrl(tracking),
    deliveryDate: shopifyStatus === 'Delivered' ? readDeliveredDateFromFulfillments(fulfillments) : '',
    status: shopifyStatus,
    statusSource: shopifyStatus ? 'shopify' : '',
    observation: shopifyStatus ? readShopifyStatusObservation(fulfillments) : '',
    shopifyShippingConfirmation: hasShopifyShippingConfirmation(fulfillments),
  }
}

function applySheetStatus(row, sheetStatusLookup) {
  const trackingNumbers = String(row.tracking ?? '')
    .split(',')
    .map((tracking) => normalizeTrackingNumber(tracking))
    .filter(Boolean)
  const orderNumber = normalizeOrderNumber(row.orderNumber)
  const item = normalizeMatchText(row.item)
  const sheetStatus = trackingNumbers
    .map((tracking) => sheetStatusLookup.byTracking.get(tracking))
    .find(Boolean)
    ?? sheetStatusLookup.byOrderItem.get(`${orderNumber}|${item}`)
    ?? sheetStatusLookup.byOrder.get(orderNumber)

  if (!sheetStatus) return row
  if (isDeliveredStatus(row.status) && !isDeliveredStatus(sheetStatus.status)) {
    return {
      ...row,
      deliveryDate: row.deliveryDate || sheetStatus.deliveryDate,
      observation: row.observation || sheetStatus.observation,
    }
  }

  return {
    ...row,
    deliveryDate: sheetStatus.deliveryDate || row.deliveryDate,
    status: sheetStatus.status,
    statusSource: 'sheet',
    observation: sheetStatus.observation || row.observation,
  }
}

function applyDetoxTeaShippingConfirmationStatus(row) {
  if (!isOriginalDetoxTeaItem(row.item) || !row.shopifyShippingConfirmation) return row
  if (String(row.status ?? '').toLowerCase().includes('failed')) return row

  return {
    ...row,
    status: 'Delivered',
    statusSource: 'shopify',
    observation: row.observation || 'Original Detox Tea marked delivered from Shopify shipping confirmation',
  }
}

function applyUspsStatus(row, uspsTrackingLookup) {
  const trackingNumbers = String(row.tracking ?? '')
    .split(',')
    .map((tracking) => normalizeTrackingNumber(tracking))
    .filter(Boolean)
  const uspsStatus = trackingNumbers
    .map((tracking) => uspsTrackingLookup.get(tracking))
    .find((trackingStatus) => trackingStatus?.status)

  if (!uspsStatus) return row
  if (row.statusSource === 'sheet' && !isDeliveredStatus(uspsStatus.status)) return row

  return {
    ...row,
    deliveryDate: uspsStatus.deliveryDate || row.deliveryDate,
    status: uspsStatus.status,
    statusSource: 'usps',
    observation: uspsStatus.observation || row.observation,
  }
}

async function loadShopifyOrders(firstPageParams) {
  const orders = []
  let pageInfo = ''
  let pageCount = 0
  const maxPages = Number(process.env.SHOPIFY_TRACKING_MAX_PAGES ?? 40)

  do {
    const params = pageInfo
      ? { limit: firstPageParams.limit, page_info: pageInfo }
      : firstPageParams
    const { payload, nextPageInfo } = await shopifyFetch('/orders.json', params)

    orders.push(...(payload.orders ?? []))
    pageInfo = nextPageInfo ?? ''
    pageCount += 1
  } while (pageInfo && pageCount < maxPages)

  return {
    orders,
    pageCount,
    hitPageLimit: Boolean(pageInfo),
  }
}

async function buildShopifyTrackingReport(limit = 250) {
  const pageLimit = Math.min(Math.max(Number(limit) || 250, 1), 250)
  const createdAtMin = process.env.SHOPIFY_TRACKING_CREATED_AT_MIN
  const fields = [
    'id',
    'name',
    'order_number',
    'created_at',
    'email',
    'phone',
    'customer',
    'shipping_address',
    'billing_address',
    'line_items',
    'fulfillments',
  ].join(',')
  const { orders, pageCount, hitPageLimit } = await loadShopifyOrders({
    status: 'any',
    limit: pageLimit,
    order: 'created_at asc',
    created_at_min: createdAtMin,
    fields,
  })
  const rows = orders.flatMap((order) => {
    const lineItems = order.line_items ?? []

    return lineItems.length > 0
      ? lineItems.map((lineItem, index) => normalizeShopifyOrderLine(order, lineItem, index))
      : [normalizeShopifyOrder(order)]
  })
  const sheetStatusLookup = await loadSheetStatusLookup()
  const rowsWithSheetStatus = rows.map((row) => applySheetStatus(row, sheetStatusLookup))
  const rowsWithDetoxTeaShippingConfirmationStatus = rowsWithSheetStatus
    .map((row) => applyDetoxTeaShippingConfirmationStatus(row))
  const uspsTrackingNumbers = rowsWithDetoxTeaShippingConfirmationStatus
    .filter((row) => !isDeliveredStatus(row.status))
    .flatMap((row) => String(row.tracking ?? '').split(','))
  const uspsTrackingLookup = await loadUspsTrackingStatuses(uspsTrackingNumbers)
  const rowsWithStatuses = rowsWithDetoxTeaShippingConfirmationStatus.map((row) => applyUspsStatus(row, uspsTrackingLookup))
  const rowsWithStatusCount = rowsWithStatuses.filter((row) => row.status).length
  const rowsWithUspsStatusCount = rowsWithStatuses.filter((row) => row.statusSource === 'usps').length
  const rowsWithShopifyStatusCount = rowsWithStatuses.filter((row) => row.statusSource === 'shopify').length
  const rowsWithDeliveryDateCount = rowsWithStatuses.filter((row) => row.deliveryDate).length
  let databaseRows = []
  let databaseSynced = false
  let databaseError = ''
  const updatedAt = new Date().toISOString()

  try {
    databaseSynced = await upsertTrackingRowsToSupabase(rowsWithStatuses, updatedAt)
    databaseRows = databaseSynced ? await loadTrackingRowsFromSupabase() : []
  } catch (error) {
    databaseError = error.message
  }
  const responseRows = databaseRows.length > 0 ? databaseRows : rowsWithStatuses

  return {
    source: databaseRows.length > 0 ? 'supabase' : 'shopify',
    updatedAt,
    orderCount: orders.length,
    pageCount,
    hitPageLimit,
    createdAtMin: createdAtMin ?? null,
    sheetStatusRows: sheetStatusCache?.rowCount ?? null,
    rowsWithStatusCount,
    rowsWithUspsStatusCount,
    rowsWithShopifyStatusCount,
    rowsWithDeliveryDateCount,
    uspsTrackingEnabled: Boolean(process.env.USPS_WEBTOOLS_USER_ID) && process.env.USPS_TRACKING_ENABLED !== '0',
    databaseSynced,
    databaseRows: databaseRows.length,
    databaseError,
    rows: responseRows,
  }
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

  return (payload.results ?? []).reduce((lookup, owner) => {
    lookup.set(String(owner.id), owner)
    if (owner.email) {
      lookup.set(String(owner.email).toLowerCase(), owner)
    }
    if (owner.userId) {
      lookup.set(String(owner.userId), owner)
    }

    return lookup
  }, new Map())
}

function readFirstOwnerName(owners, value) {
  return String(value ?? '')
    .split(/[;,]/)
    .map((ownerId) => ownerId.trim())
    .filter(Boolean)
    .map((ownerId) => ownerDisplayName(owners.get(ownerId)))
    .find(Boolean) ?? ''
}

function readMeetingHostEmailFromExternalUrl(value) {
  try {
    const eventId = new URL(String(value ?? '')).searchParams.get('eid')
    if (!eventId) return ''

    const decodedEventId = Buffer.from(eventId, 'base64').toString('utf8')

    return decodedEventId.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

function resolveMeetingHost(properties, meetingDetails, owners) {
  const externalUrlHostEmail = readMeetingHostEmailFromExternalUrl(properties.hs_meeting_external_url)

  return meetingDetails.meetingHost
    || ownerDisplayName(owners.get(externalUrlHostEmail))
    || readFirstOwnerName(owners, properties.hubspot_owner_id)
    || readFirstOwnerName(owners, properties.hs_attendee_owner_ids)
    || readFirstOwnerName(owners, properties.hs_all_owner_ids)
    || readFirstOwnerName(owners, properties.hs_user_ids_of_all_owners)
    || readFirstOwnerName(owners, properties.hs_created_by_user_id)
    || readFirstOwnerName(owners, properties.hs_created_by)
    || readFirstOwnerName(owners, properties.hs_object_source_user_id)
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
      'hs_meeting_external_url',
      'createdate',
      'hubspot_owner_id',
      'hs_attendee_owner_ids',
      'hs_all_owner_ids',
      'hs_user_ids_of_all_owners',
      'hs_created_by_user_id',
      'hs_created_by',
      'hs_object_source_user_id',
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

async function searchContactByEmail(email) {
  const rows = await hubspotSearch('contacts', {
    filterGroups: [
      {
        filters: [
          { propertyName: 'email', operator: 'EQ', value: email },
        ],
      },
    ],
    properties: ['email'],
    limit: 1,
  })

  return rows[0] ?? null
}

async function loadContactsByEmail(emails) {
  const normalizedEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))]
  const contactsByEmail = new Map()

  for (const emailChunk of chunkArray(normalizedEmails, 100)) {
    try {
      const rows = await hubspotSearch('contacts', {
        filterGroups: [
          {
            filters: [
              { propertyName: 'email', operator: 'IN', values: emailChunk },
            ],
          },
        ],
        properties: ['email'],
        limit: 100,
      })

      rows.forEach((contact) => {
        const email = normalizeEmail(contact.properties?.email)
        if (email) {
          contactsByEmail.set(email, contact)
        }
      })
    } catch {
      for (const email of emailChunk) {
        const contact = await searchContactByEmail(email)
        if (contact) {
          contactsByEmail.set(email, contact)
        }
      }
    }
  }

  return contactsByEmail
}

async function batchReadCalls(callIds) {
  const normalizedCallIds = [...new Set(callIds.map((callId) => String(callId ?? '').trim()).filter(Boolean))]
  const calls = []

  for (const callIdChunk of chunkArray(normalizedCallIds, 100)) {
    const payload = await hubspotFetch('/crm/v3/objects/calls/batch/read', {
      method: 'POST',
      body: {
        properties: [
          'hs_timestamp',
          'hs_call_direction',
          'hs_call_disposition',
          'hs_call_status',
          'hs_call_to_number',
          'hs_call_title',
          'hubspot_owner_id',
        ],
        inputs: callIdChunk.map((id) => ({ id })),
      },
    })

    calls.push(...(payload.results ?? []))
  }

  return calls
}

async function loadContactCallLookup(contactIds, owners) {
  const normalizedContactIds = [...new Set(contactIds.map((contactId) => String(contactId ?? '').trim()).filter(Boolean))]
  const callIdsByContactId = new Map()
  const contactIdsByCallId = new Map()

  for (const contactIdChunk of chunkArray(normalizedContactIds, 100)) {
    const payload = await hubspotFetch('/crm/v4/associations/contacts/calls/batch/read', {
      method: 'POST',
      body: {
        inputs: contactIdChunk.map((id) => ({ id })),
      },
    })

    ;(payload.results ?? []).forEach((result) => {
      const contactId = String(result.from?.id ?? '')
      const callIds = (result.to ?? [])
        .map((association) => String(association.toObjectId ?? ''))
        .filter(Boolean)

      callIdsByContactId.set(contactId, callIds)
      callIds.forEach((callId) => {
        const linkedContactIds = contactIdsByCallId.get(callId) ?? []
        linkedContactIds.push(contactId)
        contactIdsByCallId.set(callId, linkedContactIds)
      })
    })
  }

  const callsById = new Map(
    (await batchReadCalls([...contactIdsByCallId.keys()]))
      .map((call) => [String(call.id), normalizeCall(call, owners)]),
  )

  return [...callIdsByContactId.entries()].reduce((lookup, [contactId, callIds]) => {
    lookup.set(contactId, callIds.map((callId) => callsById.get(callId)).filter(Boolean))
    return lookup
  }, new Map())
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
    direction: properties.hs_call_direction ?? '',
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

function isPriorSameDayOutboundCall(call, scheduledAt) {
  if (!call.callTime || Number.isNaN(scheduledAt.getTime())) return false
  if (String(call.direction ?? '').toUpperCase() !== 'OUTBOUND') return false

  const callTime = new Date(call.callTime)
  if (Number.isNaN(callTime.getTime())) return false

  const appointmentDayStart = zonedStartOfDayUtc(getZonedDate(scheduledAt))

  return callTime >= appointmentDayStart && callTime < scheduledAt
}

function findPriorOutboundCall(meeting, calls, options = {}) {
  const scheduledAt = new Date(meeting.scheduledAt)
  const requireMeetingMatch = options.requireMeetingMatch ?? true

  return calls
    .filter((call) => {
      if (!isPriorSameDayOutboundCall(call, scheduledAt)) return false

      return requireMeetingMatch ? matchesMeeting(call, meeting) : true
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
  const appointmentRows = scheduleResult.rows
    .map((meeting) => {
      const properties = meeting.properties ?? {}
      const meetingDetails = parseMeetingBody(properties.hs_meeting_body, properties.hs_meeting_title)
      const scheduledAt = new Date(
        properties.hs_meeting_start_time ?? properties.hs_timestamp,
      )
      const createdAt = properties.createdate ? new Date(properties.createdate) : scheduledAt

      return {
        rowId: meeting.id,
        meetingName: properties.hs_meeting_title || 'Meeting',
        meetingDescription: stripHtml(properties.hs_meeting_body),
        date: displayDate(createdAt),
        reportDate: scheduleResult.reportDate,
        time: displayTime(scheduledAt),
        createdAt: createdAt?.toISOString() ?? null,
        scheduledAt: scheduledAt?.toISOString() ?? null,
        scheduledAgent: meetingDetails.scheduledAgent,
        meetingHost: resolveMeetingHost(properties, meetingDetails, owners),
        clientName: meetingDetails.clientName || properties.hs_meeting_title || 'Meeting',
        clientEmail: meetingDetails.clientEmail,
        phoneNumber: meetingDetails.phoneNumber,
      }
    })
  const contactsByEmail = await loadContactsByEmail(appointmentRows.map((row) => row.clientEmail))
  const contactCallLookup = await loadContactCallLookup(
    [...contactsByEmail.values()].map((contact) => contact.id),
    owners,
  )
  const rows = appointmentRows
    .map((row) => {
      const contact = contactsByEmail.get(normalizeEmail(row.clientEmail))
      const contactCalls = contact
        ? contactCallLookup.get(String(contact.id)) ?? []
        : []
      const contactTimelineCall = findPriorOutboundCall(row, contactCalls, {
        requireMeetingMatch: false,
      })
      const fallbackCall = contactTimelineCall ? null : findPriorOutboundCall(row, calls)
      const matchingCall = contactTimelineCall ?? fallbackCall
      const appointmentCancelled = isCancelledMeeting(row.meetingName)

      return {
        ...row,
        callerName: matchingCall?.callerName ?? '',
        called: matchingCall ? 'Called' : 'Not Called',
        calledDetail: matchingCall
          ? `${contactTimelineCall ? 'Contact timeline' : 'Matched'} ${matchingCall.disposition || 'outbound call'} at ${displayTime(matchingCall.callTime)}`
          : 'No same-day outbound call found before the appointment',
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
    const forceRefresh = requestUrl.searchParams.get('refresh') === '1'
    const cacheKey = `${callReportCacheVersion}:${selectedDate || 'default'}`
    const cachedReport = reportCache.get(cacheKey)

    if (!forceRefresh && cachedReport && Date.now() - cachedReport.cachedAt < (cachedReport.ttlMs ?? currentDateCacheTtlMs)) {
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
        ttlMs: getReportCacheTtlMs(report.reportDate),
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

  if (requestUrl.pathname === '/api/shopify/tracking' && request.method === 'GET') {
    const forceRefresh = requestUrl.searchParams.get('refresh') === '1'
    const limit = requestUrl.searchParams.get('limit') ?? '250'
    const cacheKey = `${limit}:${process.env.SHOPIFY_TRACKING_CREATED_AT_MIN ?? 'all'}`
    const cachedReport = trackingCache.get(cacheKey)

    if (forceRefresh) {
      sheetStatusCache = null
    }

    if (!forceRefresh && cachedReport && Date.now() - cachedReport.cachedAt < currentDateCacheTtlMs) {
      sendJson(request, response, 200, cachedReport.payload)
      return
    }

    let trackingPromise = inFlightTrackingReports.get(cacheKey)

    if (!trackingPromise) {
      trackingPromise = buildShopifyTrackingReport(limit)
      inFlightTrackingReports.set(cacheKey, trackingPromise)
    }

    try {
      const payload = await trackingPromise

      trackingCache.set(cacheKey, {
        cachedAt: Date.now(),
        payload,
      })
      sendJson(request, response, 200, payload)
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      })
    } finally {
      inFlightTrackingReports.delete(cacheKey)
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

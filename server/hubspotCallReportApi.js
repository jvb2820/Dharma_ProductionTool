import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { productPriceCatalog } from './productPriceCatalog.js'

loadLocalEnv()

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
const hubspotBaseUrl = 'https://api.hubapi.com'
const stripeBaseUrl = 'https://api.stripe.com'
const shopifyApiVersion = process.env.SHOPIFY_API_VERSION ?? '2026-01'
const defaultShopifyStatusSheetCsvUrl = 'https://docs.google.com/spreadsheets/d/1uBJLgzyYtBnPxR9x-DuHRcJz1DTJm3YSK7halebtWLg/gviz/tq?tqx=out:csv&gid=608356906'
const supabaseTrackingTable = process.env.SUPABASE_TRACKING_TABLE ?? 'tracking_dashboard'
const supabasePaymentHistoryTable = process.env.SUPABASE_PAYMENT_HISTORY_TABLE ?? 'payment_history'
const excludedTrackingOrderNumbers = readExcludedTrackingOrderNumbers()
const overdueBusinessDaysThreshold = 5
const connectedDispositionId = 'f240bbac-87c9-4f6e-bf70-924b57d47db7'
const defaultAllowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173']
const reportTimeZone = process.env.HUBSPOT_REPORT_TIMEZONE ?? 'America/New_York'
const reportCache = new Map()
const trackingCache = new Map()
const uspsTrackingCache = new Map()
const stripeVerificationCache = new Map()
let sheetStatusCache = null
const currentDateCacheTtlMs = 5 * 60 * 1000
const pastDateCacheTtlMs = 24 * 60 * 60 * 1000
const callReportCacheVersion = 'contact-call-v6'
const inFlightReports = new Map()
const inFlightTrackingReports = new Map()
const reportErrors = new Map()
const hubspotMaxAttempts = 6
const hubspotRequestSpacingMs = 250
const uspsTrackingCacheTtlMs = 30 * 60 * 1000
const stripeVerificationCacheTtlMs = 5 * 60 * 1000
const callReportErrorTtlMs = 2 * 60 * 1000
const shopifyAccessTokenRefreshBufferMs = 5 * 60 * 1000
let lastHubspotRequestAt = 0
let hubspotRequestQueue = Promise.resolve()
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

function sendJson(request, response, statusCode, payload, headers = {}) {
  const origin = request.headers.origin
  const allowedOrigin = isAllowedOrigin(origin) ? origin : allowedOrigins[0] ?? defaultAllowedOrigins[0]

  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
    ...headers,
  })
  response.end(JSON.stringify(payload))
}

function readJsonRequest(request, maxBytes = 1024 * 1024) {
  return new Promise((resolveRequest, rejectRequest) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk

      if (body.length > maxBytes) {
        request.destroy()
        rejectRequest(new Error('Request body is too large'))
      }
    })

    request.on('end', () => {
      if (!body) {
        resolveRequest({})
        return
      }

      try {
        resolveRequest(JSON.parse(body))
      } catch (error) {
        rejectRequest(new Error('Request body must be valid JSON', { cause: error }))
      }
    })

    request.on('error', rejectRequest)
  })
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

function getApiCacheHeaders(ttlMs) {
  const maxAgeSeconds = Math.max(0, Math.floor(ttlMs / 1000))

  return {
    'Cache-Control': `private, max-age=${maxAgeSeconds}, stale-while-revalidate=300`,
  }
}

function cacheCallReport(cacheKey, report) {
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
  reportErrors.delete(cacheKey)

  return payload
}

function startCallReportBuild(cacheKey, selectedDate) {
  const existingReportPromise = inFlightReports.get(cacheKey)
  if (existingReportPromise) return existingReportPromise

  const reportPromise = buildCallReport(selectedDate)
    .then((report) => cacheCallReport(cacheKey, report))
    .catch((error) => {
      reportErrors.set(cacheKey, {
        message: error.message,
        failedAt: new Date().toISOString(),
      })
      return null
    })
    .finally(() => {
      inFlightReports.delete(cacheKey)
    })

  inFlightReports.set(cacheKey, reportPromise)

  return reportPromise
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

function readSearchWords(value) {
  return normalizeText(value)
    .split(' ')
    .filter((word) => word.length >= 4)
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

function paymentDateToIso(value) {
  const rawValue = String(value ?? '').trim()
  if (!rawValue) return null

  const isoMatch = rawValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  const slashMatch = rawValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  let year
  let month
  let day

  if (isoMatch) {
    year = Number(isoMatch[1])
    month = Number(isoMatch[2])
    day = Number(isoMatch[3])
  } else if (slashMatch) {
    month = Number(slashMatch[1])
    day = Number(slashMatch[2])
    year = Number(slashMatch[3])
    if (year < 100) year += 2000
  } else {
    const parsedDate = new Date(rawValue)
    if (Number.isNaN(parsedDate.getTime())) return null

    year = parsedDate.getFullYear()
    month = parsedDate.getMonth() + 1
    day = parsedDate.getDate()
  }

  const date = new Date(Date.UTC(year, month - 1, day, 12))

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return date.toISOString().slice(0, 10)
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
    const retryableStatus = response.status === 429 || response.status >= 500

    if (!retryableStatus || attempt === hubspotMaxAttempts) {
      throw new Error(`HubSpot request failed (${response.status}): ${body}`)
    }

    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    const retryDelayMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : attempt * (response.status === 429 ? 2500 : 5000)

    await delay(retryDelayMs)
  }
}

async function waitForHubspotSlot() {
  const previousRequest = hubspotRequestQueue
  let releaseSlot

  hubspotRequestQueue = new Promise((resolveSlot) => {
    releaseSlot = resolveSlot
  })

  await previousRequest

  try {
    const elapsedMs = Date.now() - lastHubspotRequestAt
    const waitMs = Math.max(0, hubspotRequestSpacingMs - elapsedMs)

    if (waitMs > 0) {
      await delay(waitMs)
    }

    lastHubspotRequestAt = Date.now()
  } finally {
    releaseSlot()
  }
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

function normalizePaymentHistoryKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function buildPaymentHistoryRowId(row, paymentDate, amountCents) {
  const key = [
    paymentDate ?? row.Date ?? '',
    amountCents ?? '',
    row['Customer Name'],
    row['Staff Name'],
    row.Description,
    row['Tender Note'],
  ].map(normalizePaymentHistoryKey).join('|')

  return createHash('sha256').update(key).digest('hex')
}

function buildPaymentHistoryDatabaseRow(row) {
  const paymentDate = paymentDateToIso(row.Date)
  const totalCollectedCents = parseMoneyToCents(row['Total Collected'])

  return {
    row_id: buildPaymentHistoryRowId(row, paymentDate, totalCollectedCents),
    payment_date: paymentDate,
    display_date: row.Date || null,
    total_collected: row['Total Collected'] || null,
    total_collected_cents: totalCollectedCents,
    tender_note: row['Tender Note'] || null,
    staff_name: row['Staff Name'] || null,
    description: row.Description || null,
    customer_name: row['Customer Name'] || null,
    discount_name: row['Discount Name'] || null,
    verification: row.Verification || null,
    dharma_orders: row['Dharma Orders'] || null,
    raw_data: row,
    imported_at: new Date().toISOString(),
  }
}

function normalizePaymentHistoryDatabaseRow(row) {
  return {
    rowId: row.row_id,
    Date: isoDateToDisplay(row.payment_date) || row.display_date || '',
    'Total Collected': row.total_collected ?? '',
    'Tender Note': row.tender_note ?? '',
    'Staff Name': row.staff_name ?? '',
    Description: row.description ?? '',
    'Customer Name': row.customer_name ?? '',
    'Discount Name': row.discount_name ?? '',
    Verification: row.verification ?? '',
    'Dharma Orders': row.dharma_orders ?? row.raw_data?.['Dharma Orders'] ?? '',
    importedAt: row.imported_at ?? null,
  }
}

async function upsertPaymentHistoryRowsToSupabase(rows) {
  if (!hasSupabaseConfig() || rows.length === 0) return []

  const databaseRows = rows.map(buildPaymentHistoryDatabaseRow)

  for (let index = 0; index < databaseRows.length; index += 500) {
    const batch = databaseRows.slice(index, index + 500)

    await supabaseRequest(`/${supabasePaymentHistoryTable}?on_conflict=row_id`, {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: batch,
    })
  }

  return databaseRows
}

async function loadPaymentHistoryRowsFromSupabase() {
  if (!hasSupabaseConfig()) return []

  const params = new URLSearchParams({
    select: '*',
    order: 'payment_date.desc,imported_at.desc,row_id.asc',
  })
  const rows = await supabaseRequest(`/${supabasePaymentHistoryTable}?${params.toString()}`)

  return Array.isArray(rows) ? rows.map(normalizePaymentHistoryDatabaseRow) : []
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
    || text.includes('delivery attempt')
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
    || shipmentStatus === 'attempted_delivery'
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
      'hs_createdate',
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

async function loadContactIdsByCallId(callIds) {
  const normalizedCallIds = [...new Set(callIds.map((callId) => String(callId ?? '').trim()).filter(Boolean))]
  const contactIdsByCallId = new Map()

  for (const callIdChunk of chunkArray(normalizedCallIds, 100)) {
    const payload = await hubspotFetch('/crm/v4/associations/calls/contacts/batch/read', {
      method: 'POST',
      body: {
        inputs: callIdChunk.map((id) => ({ id })),
      },
    })

    ;(payload.results ?? []).forEach((result) => {
      const callId = String(result.from?.id ?? '')
      const contactIds = (result.to ?? [])
        .map((association) => String(association.toObjectId ?? ''))
        .filter(Boolean)

      contactIdsByCallId.set(callId, contactIds)
    })
  }

  return contactIdsByCallId
}

async function loadContactEmailsById(contactIds) {
  const normalizedContactIds = [...new Set(contactIds.map((contactId) => String(contactId ?? '').trim()).filter(Boolean))]
  const contactEmailsById = new Map()

  for (const contactIdChunk of chunkArray(normalizedContactIds, 100)) {
    const payload = await hubspotFetch('/crm/v3/objects/contacts/batch/read', {
      method: 'POST',
      body: {
        properties: ['email'],
        inputs: contactIdChunk.map((id) => ({ id })),
      },
    })

    ;(payload.results ?? []).forEach((contact) => {
      const email = normalizeEmail(contact.properties?.email)
      if (email) {
        contactEmailsById.set(String(contact.id), email)
      }
    })
  }

  return contactEmailsById
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

function isPreviousDayOutboundCall(call, scheduledAt) {
  if (!call.callTime || Number.isNaN(scheduledAt.getTime())) return false
  if (String(call.direction ?? '').toUpperCase() !== 'OUTBOUND') return false

  const callTime = new Date(call.callTime)
  if (Number.isNaN(callTime.getTime())) return false

  const appointmentDayStart = zonedStartOfDayUtc(getZonedDate(scheduledAt))
  const previousDayStart = new Date(appointmentDayStart.getTime() - 24 * 60 * 60 * 1000)

  return callTime >= previousDayStart && callTime < appointmentDayStart
}

function sortCallsByConnectionAndTime(left, right) {
  const leftConnected = left.disposition === 'CONNECTED' ? 1 : 0
  const rightConnected = right.disposition === 'CONNECTED' ? 1 : 0

  if (leftConnected !== rightConnected) return rightConnected - leftConnected

  return new Date(right.callTime) - new Date(left.callTime)
}

function sortCallsForMatching(calls) {
  return [...calls].sort(sortCallsByConnectionAndTime)
}

function getPriorOutboundCalls(meeting, calls, options = {}) {
  const scheduledAt = new Date(meeting.scheduledAt)
  const requireMeetingMatch = options.requireMeetingMatch ?? true
  const preSorted = options.preSorted ?? false

  const matchingCalls = calls
    .filter((call) => {
      if (!isPriorSameDayOutboundCall(call, scheduledAt)) return false

      return requireMeetingMatch ? matchesMeeting(call, meeting) : true
    })

  return preSorted ? matchingCalls : matchingCalls.sort(sortCallsByConnectionAndTime)
}

function findPriorOutboundCall(meeting, calls, options = {}) {
  return getPriorOutboundCalls(meeting, calls, options)[0]
}

function isCreatedWithinOneHourOfAppointment(createdAt, scheduledAt) {
  if (!createdAt || !scheduledAt) return false

  const createdTime = new Date(createdAt)
  const scheduledTime = new Date(scheduledAt)

  if (Number.isNaN(createdTime.getTime()) || Number.isNaN(scheduledTime.getTime())) return false

  const millisecondsUntilAppointment = scheduledTime.getTime() - createdTime.getTime()

  return millisecondsUntilAppointment >= 0 && millisecondsUntilAppointment <= 60 * 60 * 1000
}

function getPreviousDayOutboundCalls(meeting, calls, options = {}) {
  const scheduledAt = new Date(meeting.scheduledAt)
  const requireMeetingMatch = options.requireMeetingMatch ?? true
  const preSorted = options.preSorted ?? false

  const matchingCalls = calls
    .filter((call) => {
      if (!isPreviousDayOutboundCall(call, scheduledAt)) return false

      return requireMeetingMatch ? matchesMeeting(call, meeting) : true
    })

  return preSorted ? matchingCalls : matchingCalls.sort(sortCallsByConnectionAndTime)
}

function addCallIndexEntry(index, key, call) {
  if (!key) return

  const indexedCalls = index.get(key) ?? []
  indexedCalls.push(call)
  index.set(key, indexedCalls)
}

function buildCallCandidateIndexes(calls) {
  const callsByPhone = new Map()
  const callsByTitleWord = new Map()

  calls.forEach((call) => {
    const phoneSuffix = call.phoneNumber ? call.phoneNumber.slice(-10) : ''

    addCallIndexEntry(callsByPhone, phoneSuffix, call)
    readSearchWords(call.callTitle).forEach((word) => {
      addCallIndexEntry(callsByTitleWord, word, call)
    })
  })

  callsByPhone.forEach((indexedCalls, key) => callsByPhone.set(key, sortCallsForMatching(indexedCalls)))
  callsByTitleWord.forEach((indexedCalls, key) => callsByTitleWord.set(key, sortCallsForMatching(indexedCalls)))

  return {
    callsByPhone,
    callsByTitleWord,
  }
}

function getFallbackCandidateCalls(meeting, callIndexes) {
  const phoneSuffix = normalizePhone(meeting.phoneNumber).slice(-10)
  if (phoneSuffix) {
    return callIndexes.callsByPhone.get(phoneSuffix) ?? []
  }

  const candidateLookup = new Map()

  readSearchWords(meeting.clientName).forEach((word) => {
    ;(callIndexes.callsByTitleWord.get(word) ?? []).forEach((call) => {
      candidateLookup.set(call.callId, call)
    })
  })

  return sortCallsForMatching(candidateLookup.values())
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

function parseMoneyToCents(value) {
  if (value === null || value === undefined || value === '') return null

  const cleanedValue = String(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim()

  if (!cleanedValue) return null

  const amount = Number(cleanedValue)

  if (!Number.isFinite(amount)) return null

  return Math.round(Math.abs(amount) * 100)
}

function extractEmails(value) {
  const normalizedValue = String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s*@\s*/g, '@')

  const matches = normalizedValue.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)

  return [...new Set((matches ?? []).map(normalizeEmail))]
}

function getUploadedRowEmails(row) {
  return [
    ...extractEmails(row['Tender Note']),
    ...extractEmails(row['Customer Name']),
  ]
}

function getStripeChargeEmails(charge) {
  const customer = typeof charge.customer === 'object' && charge.customer !== null ? charge.customer : null

  return [
    charge.billing_details?.email,
    charge.receipt_email,
    customer?.email,
  ]
    .map(normalizeEmail)
    .filter(Boolean)
}

function stripeChargeMatchesUploadedCustomer(charge, row) {
  const uploadedEmails = getUploadedRowEmails(row)

  if (!uploadedEmails.length) return true

  const stripeEmails = getStripeChargeEmails(charge)

  return uploadedEmails.some((uploadedEmail) => stripeEmails.includes(uploadedEmail))
}

function parsePaymentDateRange(value) {
  const paymentDate = paymentDateToIso(value)
  if (!paymentDate) return null

  const start = zonedStartOfDayUtc(paymentDate)
  const end = zonedStartOfDayUtc(addDaysToIsoDate(paymentDate, 1))

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null

  return {
    date: paymentDate,
    gte: Math.floor(start.getTime() / 1000),
    lt: Math.floor(end.getTime() / 1000),
  }
}

function getStripeApiKeys() {
  return [
    process.env.STRIPE_SECRET_KEY,
    process.env.STRIPE_API_KEY,
  ]
    .map((key) => String(key ?? '').trim())
    .filter(Boolean)
    .filter((key, index, keys) => keys.indexOf(key) === index)
}

async function stripeGet(path, params = {}) {
  const apiKeys = getStripeApiKeys()

  if (!apiKeys.length) {
    throw new Error('Missing STRIPE_SECRET_KEY')
  }

  const requestUrl = new URL(`${stripeBaseUrl}${path}`)

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      requestUrl.searchParams.set(key, String(value))
    }
  })

  let lastStatus = null
  let lastMessage = ''

  for (const apiKey of apiKeys) {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (response.ok) {
      return response.json()
    }

    lastStatus = response.status

    try {
      const payload = await response.json()
      lastMessage = payload?.error?.message ?? ''
    } catch {
      lastMessage = ''
    }

    if (response.status !== 401) {
      throw new Error(`Stripe request failed (${response.status})${lastMessage ? `: ${lastMessage}` : ''}`)
    }
  }

  throw new Error(
    `Stripe rejected the configured API key${apiKeys.length === 1 ? '' : 's'} (${lastStatus ?? 401})${lastMessage ? `: ${lastMessage}` : ''}. Stripe server keys usually start with sk_ or rk_.`,
  )
}

async function listStripeChargesForRow(row, amountCents) {
  const dateRange = parsePaymentDateRange(row.Date)

  if (!dateRange) return []

  const charges = await listStripeChargesForDateRange(dateRange)

  return charges.filter((charge) => charge.amount === amountCents)
}

async function listStripeChargesForDateRange(dateRange) {
  const charges = []
  let startingAfter = ''

  do {
    const payload = await stripeGet('/v1/charges', {
      limit: 100,
      'created[gte]': dateRange?.gte,
      'created[lt]': dateRange?.lt,
      'expand[]': 'data.customer',
      starting_after: startingAfter,
    })

    const pageCharges = payload.data ?? []
    charges.push(...pageCharges)
    startingAfter = payload.has_more && pageCharges.length ? pageCharges.at(-1).id : ''
  } while (startingAfter && charges.length < 500)

  return charges.filter(chargeMatchesUploadedRow)
}

function chargeMatchesUploadedRow(charge) {
  return charge.paid === true || charge.status === 'succeeded'
}

function formatStripeAmount(amount, currency) {
  const currencyCode = String(currency || 'usd').toUpperCase()

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format((amount ?? 0) / 100)
}

function formatStripeCreatedAt(created) {
  if (!created) return ''

  return new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(created * 1000))
}

function normalizeStripeChargeForUnrecorded(charge, paymentDate) {
  const customer = typeof charge.customer === 'object' && charge.customer !== null ? charge.customer : null

  return {
    id: charge.id,
    paymentDate,
    amount: formatStripeAmount(charge.amount, charge.currency),
    amountCents: charge.amount ?? 0,
    currency: String(charge.currency ?? 'usd').toUpperCase(),
    createdAt: formatStripeCreatedAt(charge.created),
    customerName: charge.billing_details?.name ?? '',
    customerEmail: charge.billing_details?.email ?? charge.receipt_email ?? customer?.email ?? '',
    customerPhone: charge.billing_details?.phone ?? customer?.phone ?? '',
    customerState: charge.billing_details?.address?.state ?? '',
    description: charge.description ?? '',
    status: charge.status ?? '',
    warning: charge.unrecordedWarning ?? '',
  }
}

function countUploadedPaymentAmountsByDate(rows) {
  return rows.reduce((lookup, row) => {
    const dateRange = parsePaymentDateRange(row.Date)
    const amountCents = parseMoneyToCents(row['Total Collected'])

    if (!dateRange?.date || !amountCents) return lookup

    const amountCounts = lookup.get(dateRange.date) ?? new Map()
    amountCounts.set(amountCents, (amountCounts.get(amountCents) ?? 0) + 1)
    lookup.set(dateRange.date, amountCounts)

    return lookup
  }, new Map())
}

function countUploadedPaymentAmountsByDateAndEmail(rows) {
  return rows.reduce((lookup, row) => {
    const dateRange = parsePaymentDateRange(row.Date)
    const amountCents = parseMoneyToCents(row['Total Collected'])
    const rowEmails = getUploadedRowEmails(row)

    if (!dateRange?.date || !amountCents || rowEmails.length === 0) return lookup

    const emailAmounts = lookup.get(dateRange.date) ?? new Map()

    rowEmails.forEach((email) => {
      const amountCounts = emailAmounts.get(email) ?? new Map()
      amountCounts.set(amountCents, (amountCounts.get(amountCents) ?? 0) + 1)
      emailAmounts.set(email, amountCounts)
    })

    lookup.set(dateRange.date, emailAmounts)

    return lookup
  }, new Map())
}

function useUploadedAmountCount(amountCounts, amountCents) {
  const remainingUploadedCount = amountCounts?.get(amountCents) ?? 0

  if (remainingUploadedCount <= 0) return false

  amountCounts.set(amountCents, remainingUploadedCount - 1)
  return true
}

function findChargeSubsetIndexesForAmount(charges, targetAmountCents) {
  if (targetAmountCents <= 0 || charges.length === 0 || charges.length > 16) return null

  const indexedCharges = charges
    .map((charge, index) => ({ charge, index }))
    .sort((left, right) => (right.charge.amount ?? 0) - (left.charge.amount ?? 0))

  function search(startIndex, remainingAmount, selectedIndexes) {
    if (remainingAmount === 0) return selectedIndexes
    if (remainingAmount < 0) return null

    for (let index = startIndex; index < indexedCharges.length; index += 1) {
      const current = indexedCharges[index]
      const result = search(index + 1, remainingAmount - (current.charge.amount ?? 0), [
        ...selectedIndexes,
        current.index,
      ])

      if (result) return result
    }

    return null
  }

  return search(0, targetAmountCents, [])
}

function filterChargesMatchedByUploadedEmailTotals(charges, uploadedAmountCountsByEmail) {
  const chargesByEmail = charges.reduce((lookup, charge) => {
    const email = getStripeChargeEmails(charge)[0]

    if (!email) return lookup

    const emailCharges = lookup.get(email) ?? []
    emailCharges.push(charge)
    lookup.set(email, emailCharges)

    return lookup
  }, new Map())
  const matchedChargeIds = new Set()

  chargesByEmail.forEach((emailCharges, email) => {
    const uploadedAmountCounts = uploadedAmountCountsByEmail.get(email)
    if (!uploadedAmountCounts) return

    const unmatchedEmailCharges = [...emailCharges]

    uploadedAmountCounts.forEach((count, uploadedAmountCents) => {
      for (let index = 0; index < count; index += 1) {
        const matchedIndexes = findChargeSubsetIndexesForAmount(unmatchedEmailCharges, uploadedAmountCents)

        if (!matchedIndexes) break

        matchedIndexes
          .sort((left, right) => right - left)
          .forEach((matchedIndex) => {
            const [matchedCharge] = unmatchedEmailCharges.splice(matchedIndex, 1)
            if (matchedCharge?.id) {
              matchedChargeIds.add(matchedCharge.id)
            }
          })
      }
    })
  })

  return charges.filter((charge) => !matchedChargeIds.has(charge.id))
}

function getChargeEmailAmountKey(charge) {
  const email = getStripeChargeEmails(charge)[0]

  if (!email || !charge.amount) return ''

  return `${email}:${charge.amount}`
}

function findDuplicateStripeChargesNotCoveredBySheet(stripeCharges, uploadedAmountCountsByEmail) {
  const chargesByEmailAndAmount = stripeCharges.reduce((lookup, charge) => {
    const key = getChargeEmailAmountKey(charge)

    if (!key) return lookup

    const matchingCharges = lookup.get(key) ?? []
    matchingCharges.push(charge)
    lookup.set(key, matchingCharges)

    return lookup
  }, new Map())
  const duplicateChargeIds = new Set()

  chargesByEmailAndAmount.forEach((matchingCharges) => {
    if (matchingCharges.length <= 1) return

    const email = getStripeChargeEmails(matchingCharges[0])[0]
    const amount = matchingCharges[0].amount
    const uploadedCount = uploadedAmountCountsByEmail.get(email)?.get(amount) ?? 0
    const duplicateCount = Math.max(0, matchingCharges.length - uploadedCount)

    matchingCharges
      .sort((left, right) => (right.created ?? 0) - (left.created ?? 0))
      .slice(0, duplicateCount)
      .forEach((charge) => duplicateChargeIds.add(charge.id))
  })

  return duplicateChargeIds
}

function findStripeChargesMatchingUploadedEmailTotal(row, charges, amountCents) {
  const rowEmails = getUploadedRowEmails(row)

  if (rowEmails.length === 0) return []

  for (const rowEmail of rowEmails) {
    const emailCharges = charges.filter((charge) => getStripeChargeEmails(charge).includes(rowEmail))
    const matchedIndexes = findChargeSubsetIndexesForAmount(emailCharges, amountCents)

    if (matchedIndexes) {
      return matchedIndexes.map((index) => emailCharges[index])
    }
  }

  return []
}

async function findStripePaymentsNotInSheet(rows) {
  const uploadedAmountsByDate = countUploadedPaymentAmountsByDate(rows)
  const uploadedEmailAmountsByDate = countUploadedPaymentAmountsByDateAndEmail(rows)
  const unrecordedPayments = []

  for (const [paymentDate, amountCounts] of uploadedAmountsByDate) {
    const dateRange = parsePaymentDateRange(paymentDate)
    if (!dateRange) continue

    const stripeCharges = await listStripeChargesForDateRange(dateRange)
    const uploadedAmountCountsByEmail = uploadedEmailAmountsByDate.get(paymentDate) ?? new Map()
    const duplicateChargeIds = findDuplicateStripeChargesNotCoveredBySheet(stripeCharges, uploadedAmountCountsByEmail)
    const unmatchedCharges = []

    stripeCharges.forEach((charge) => {
      if (duplicateChargeIds.has(charge.id)) {
        unmatchedCharges.push({
          ...charge,
          unrecordedWarning: 'Duplicate Amount',
        })
        return
      }

      if (useUploadedAmountCount(amountCounts, charge.amount)) {
        const chargeEmail = getStripeChargeEmails(charge)[0]
        const uploadedAmountCountsForEmail = uploadedEmailAmountsByDate.get(paymentDate)?.get(chargeEmail)

        useUploadedAmountCount(uploadedAmountCountsForEmail, charge.amount)
        return
      }

      unmatchedCharges.push(charge)
    })

    const remainingUnmatchedCharges = filterChargesMatchedByUploadedEmailTotals(
      unmatchedCharges,
      uploadedAmountCountsByEmail,
    )

    remainingUnmatchedCharges.forEach((charge) => {
      unrecordedPayments.push(normalizeStripeChargeForUnrecorded(charge, paymentDate))
    })
  }

  return unrecordedPayments
}

async function verifyStripePaymentRow(row) {
  const amountCents = parseMoneyToCents(row['Total Collected'])

  if (!amountCents) {
    return {
      verification: 'No',
      matchedChargeId: '',
    }
  }

  const cacheKey = `${row.Date ?? ''}:${amountCents}:${getUploadedRowEmails(row).join(',')}`
  const cachedVerification = stripeVerificationCache.get(cacheKey)

  if (cachedVerification && Date.now() - cachedVerification.cachedAt < stripeVerificationCacheTtlMs) {
    return cachedVerification.result
  }

  const charges = await listStripeChargesForRow(row, amountCents)
  const matchedCharge = charges.find((charge) => stripeChargeMatchesUploadedCustomer(charge, row))
  const dateRange = parsePaymentDateRange(row.Date)
  const matchedSplitCharges = matchedCharge
    ? []
    : !dateRange
      ? []
    : findStripeChargesMatchingUploadedEmailTotal(
      row,
      await listStripeChargesForDateRange(dateRange),
      amountCents,
    )
  const result = {
    verification: matchedCharge || matchedSplitCharges.length > 0 ? 'Yes' : 'No',
    matchedChargeId: matchedCharge?.id ?? matchedSplitCharges.map((charge) => charge.id).join(','),
  }

  stripeVerificationCache.set(cacheKey, {
    cachedAt: Date.now(),
    result,
  })

  return result
}

async function verifyStripePaymentRows(rows) {
  const results = []

  for (const row of rows) {
    const result = await verifyStripePaymentRow(row)
    results.push(result)
  }

  return results
}

function parseDescriptionLineItems(description) {
  const text = String(description ?? '').trim()
  if (!text) return []

  const items = []
  const pattern = /(\d+)\s*x\s+(.+?)(?=,\s*\d+\s*x\s+|$)/gis
  let match

  while ((match = pattern.exec(text)) !== null) {
    const quantity = Number(match[1])
    const name = String(match[2] ?? '').trim().replace(/\s+/g, ' ')

    if (Number.isFinite(quantity) && quantity > 0 && name) {
      items.push({ quantity, name })
    }
  }

  return items.length > 0 ? items : [{ quantity: 1, name: text }]
}

function readPricingWords(value) {
  return normalizeMatchText(value)
    .split(' ')
    .filter((word) => word.length >= 3)
}

function normalizePricingText(value) {
  return normalizeMatchText(value)
    .replace(/\bcompounded\b/g, ' ')
    .replace(/\bcapsules\b/g, ' capsule ')
    .replace(/\binjection\b/g, ' ')
    .replace(/\bpersonalized\b/g, ' ')
    .replace(/\bnutrition\b/g, 'nutrition')
    .replace(/\bslim\s+boost\b/g, 'slimboost')
    .replace(/\s+/g, ' ')
    .trim()
}

function readDurationMonths(value) {
  const text = normalizeMatchText(value)

  if (/\b(?:one|1)\s+month\b/.test(text)) return 1
  if (/\b(?:two|2)\s+months?\b/.test(text)) return 2
  if (/\b(?:three|3)\s+months?\b/.test(text)) return 3
  if (/\b(?:four|4)\s+months?\b/.test(text)) return 4
  if (/\b(?:six|6)\s+months?\b/.test(text)) return 6
  if (/\b(?:twelve|12)\s+months?\b/.test(text)) return 12

  return null
}

function getProductPricingCatalog() {
  return productPriceCatalog.map((product, index) => ({
    productId: `local-${index}`,
    variantId: `local-${index}`,
    productTitle: product.name,
    variantTitle: '',
    sku: '',
    productType: 'Local price catalog',
    tags: '',
    price: String(product.price),
    priceCents: parseMoneyToCents(product.price),
    searchableText: product.name,
    normalizedText: normalizePricingText(product.name),
    words: new Set(readPricingWords(normalizePricingText(product.name))),
  }))
}

function scoreCatalogMatch(item, catalogItem) {
  const rawItemText = normalizeMatchText(item.name)
  const itemText = normalizePricingText(item.name)
  const itemWords = readPricingWords(itemText)

  if (!itemText || itemWords.length === 0) return 0

  let score = 0
  const productTitleText = normalizePricingText(catalogItem.productTitle)
  const catalogDurationMonths = readDurationMonths(catalogItem.productTitle)
  const itemDurationMonths = readDurationMonths(item.name)

  if (catalogItem.normalizedText.includes(itemText)) score += 120
  if (productTitleText && itemText.includes(productTitleText)) score += 80

  itemWords.forEach((word) => {
    if (catalogItem.words.has(word)) score += 12
  })

  const itemDose = itemText.match(/\b\d+\s*(?:mg|ml|iu)\b/i)?.[0]
  if (itemDose && catalogItem.normalizedText.includes(normalizePricingText(itemDose))) score += 35

  ;['nad', 'glp', 'b12'].forEach((term) => {
    if (itemWords.includes(term) && catalogItem.words.has(term)) score += 30
  })

  if (itemDurationMonths && catalogDurationMonths === itemDurationMonths) score += 90
  if (catalogDurationMonths && itemDurationMonths && catalogDurationMonths !== itemDurationMonths) score -= 120
  if (catalogDurationMonths && !itemDurationMonths && catalogDurationMonths > 1) score -= 80
  if (catalogDurationMonths === 1 && !itemDurationMonths) score += 18

  if (rawItemText.includes('capsule')) {
    if (catalogItem.normalizedText.includes('cellular') || catalogItem.normalizedText.includes('anti aging')) {
      score += 90
    }
    if (catalogDurationMonths) {
      score -= 110
    }
  }

  if (itemText.includes('compounded') && catalogItem.normalizedText.includes('compounded')) score += 15
  if (itemText.includes('consultation') && catalogItem.normalizedText.includes('consultation')) score += 20

  return score
}

function findBestCatalogMatch(item, catalog) {
  const scoredMatches = catalog
    .map((catalogItem) => ({
      catalogItem,
      score: scoreCatalogMatch(item, catalogItem),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score)

  const bestMatch = scoredMatches[0]

  if (!bestMatch || bestMatch.score < 24) return null

  return {
    ...bestMatch.catalogItem,
    score: bestMatch.score,
  }
}

function parseDiscountAdjustment(discountName, subtotalCents) {
  const value = String(discountName ?? '').trim()

  if (!value || value === '-') {
    return {
      label: '',
      discountCents: 0,
      note: '',
    }
  }

  const percentMatch = value.match(/(\d+(?:\.\d+)?)\s*%/)
  if (percentMatch) {
    const percent = Number(percentMatch[1])
    const discountCents = Number.isFinite(percent)
      ? Math.round(subtotalCents * (percent / 100))
      : 0

    return {
      label: value,
      discountCents,
      note: `${percent}% parsed from discount name`,
    }
  }

  const fixedDiscountCents = parseMoneyToCents(value)

  if (fixedDiscountCents) {
    return {
      label: value,
      discountCents: fixedDiscountCents,
      note: 'Fixed amount parsed from discount name',
    }
  }

  return {
    label: value,
    discountCents: 0,
    note: 'Discount name found, but amount was not parseable',
  }
}

function formatCents(cents) {
  return formatStripeAmount(cents ?? 0, 'usd')
}

async function auditShopifyPricingRows(rows) {
  const catalog = getProductPricingCatalog()

  return rows.slice(0, 500).map((row, rowIndex) => {
    const lineItems = parseDescriptionLineItems(row.Description)
    const auditedItems = lineItems.map((item) => {
      const match = findBestCatalogMatch(item, catalog)
      const unitPriceCents = match?.priceCents ?? 0
      const lineTotalCents = unitPriceCents * item.quantity

      return {
        quantity: item.quantity,
        name: item.name,
        matched: Boolean(match),
        matchScore: match?.score ?? 0,
        productTitle: match?.productTitle ?? '',
        variantTitle: match?.variantTitle ?? '',
        sku: match?.sku ?? '',
        unitPrice: match ? formatCents(unitPriceCents) : '',
        lineTotal: match ? formatCents(lineTotalCents) : '',
        lineTotalCents,
      }
    })
    const subtotalCents = auditedItems.reduce((total, item) => total + item.lineTotalCents, 0)
    const discount = parseDiscountAdjustment(row['Discount Name'], subtotalCents)
    const expectedTotalCents = Math.max(0, subtotalCents - discount.discountCents)
    const collectedCents = parseMoneyToCents(row['Total Collected']) ?? 0
    const differenceCents = collectedCents - expectedTotalCents
    const hasMissingMatches = auditedItems.some((item) => !item.matched)
    const status = hasMissingMatches
      ? 'Needs Review'
      : Math.abs(differenceCents) <= 1
        ? 'Match'
        : 'Mismatch'

    return {
      rowIndex,
      customerName: row['Customer Name'] ?? '',
      description: row.Description ?? '',
      discountName: row['Discount Name'] ?? '',
      subtotal: formatCents(subtotalCents),
      discount: discount.discountCents ? `-${formatCents(discount.discountCents)}` : '$0.00',
      discountNote: discount.note,
      expectedTotal: formatCents(expectedTotalCents),
      totalCollected: formatCents(collectedCents),
      difference: formatCents(differenceCents),
      status,
      items: auditedItems,
    }
  })
}

async function buildCallReport(selectedDate) {
  const [owners, scheduleResult, outboundCalls] = await Promise.all([
    loadOwners(),
    loadScheduledContactsForDate(selectedDate),
    loadOutboundCallsForDate(selectedDate),
  ])
  const calls = sortCallsForMatching(outboundCalls.map((call) => normalizeCall(call, owners)))
  const callIndexes = buildCallCandidateIndexes(calls)
  const contactIdsByCallId = await loadContactIdsByCallId(calls.map((call) => call.callId))
  const contactEmailsById = await loadContactEmailsById(
    [...contactIdsByCallId.values()].flat(),
  )
  const callsByContactEmail = calls.reduce((lookup, call) => {
    const contactEmails = (contactIdsByCallId.get(String(call.callId)) ?? [])
      .map((contactId) => contactEmailsById.get(String(contactId)))
      .filter(Boolean)

    contactEmails.forEach((email) => {
      const contactCalls = lookup.get(email) ?? []
      contactCalls.push(call)
      lookup.set(email, contactCalls)
    })

    return lookup
  }, new Map())
  callsByContactEmail.forEach((contactCalls, email) => {
    callsByContactEmail.set(email, sortCallsForMatching(contactCalls))
  })
  const appointmentRows = scheduleResult.rows
    .map((meeting) => {
      const properties = meeting.properties ?? {}
      const meetingDetails = parseMeetingBody(properties.hs_meeting_body, properties.hs_meeting_title)
      const scheduledAt = new Date(
        properties.hs_meeting_start_time ?? properties.hs_timestamp,
      )
      const createdAt = properties.hs_createdate || properties.createdate
        ? new Date(properties.hs_createdate ?? properties.createdate)
        : null

      return {
        rowId: meeting.id,
        meetingName: properties.hs_meeting_title || 'Meeting',
        meetingDescription: stripHtml(properties.hs_meeting_body),
        date: displayDate(scheduledAt),
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
  const rows = appointmentRows
    .map((row) => {
      const contactCalls = callsByContactEmail.get(normalizeEmail(row.clientEmail)) ?? []
      const contactTimelineCall = findPriorOutboundCall(row, contactCalls, {
        requireMeetingMatch: false,
        preSorted: true,
      })
      const fallbackCandidateCalls = contactTimelineCall ? [] : getFallbackCandidateCalls(row, callIndexes)
      const fallbackCall = contactTimelineCall
        ? null
        : findPriorOutboundCall(row, fallbackCandidateCalls, { preSorted: true })
      const matchingCall = contactTimelineCall ?? fallbackCall
      const qualifyingCalls = contactTimelineCall
        ? getPriorOutboundCalls(row, contactCalls, { requireMeetingMatch: false, preSorted: true })
        : getPriorOutboundCalls(row, fallbackCandidateCalls, { preSorted: true })
      const previousDayContactCalls = getPreviousDayOutboundCalls(row, contactCalls, {
        requireMeetingMatch: false,
        preSorted: true,
      })
      const previousDayFallbackCalls = previousDayContactCalls.length > 0
        ? []
        : getPreviousDayOutboundCalls(row, getFallbackCandidateCalls(row, callIndexes), { preSorted: true })
      const previousDayCalls = previousDayContactCalls.length > 0
        ? previousDayContactCalls
        : previousDayFallbackCalls
      const previousDayCall = previousDayCalls[0]
      const appointmentCancelled = isCancelledMeeting(row.meetingName)
      const outboundExempt = isCreatedWithinOneHourOfAppointment(row.createdAt, row.scheduledAt)

      return {
        ...row,
        callerName: matchingCall?.callerName ?? '',
        qualifyingCallers: [...new Set(qualifyingCalls.map((call) => call.callerName).filter(Boolean))],
        previousDayCallerName: previousDayCall?.callerName ?? '',
        previousDayCallers: [...new Set(previousDayCalls.map((call) => call.callerName).filter(Boolean))],
        previousDayCalledDetail: previousDayCall
          ? `${previousDayContactCalls.length > 0 ? 'Previous day contact timeline' : 'Previous day matched'} ${previousDayCall.disposition || 'outbound call'} at ${displayTime(previousDayCall.callTime)}`
          : 'No previous-day outbound call found',
        called: matchingCall ? 'Called' : outboundExempt ? 'Not Required' : 'Not Called',
        calledDetail: matchingCall
          ? `${contactTimelineCall ? 'Contact timeline' : 'Matched'} ${matchingCall.disposition || 'outbound call'} at ${displayTime(matchingCall.callTime)}`
          : outboundExempt
            ? 'Outbound call not required: meeting was created within 1 hour of the appointment'
            : 'No same-day outbound call found before the appointment',
        outboundExempt,
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
    }, {
      'Cache-Control': 'no-store',
    })
    return
  }

  if (requestUrl.pathname === '/api/payment-history' && request.method === 'GET') {
    try {
      const rows = await loadPaymentHistoryRowsFromSupabase()

      sendJson(request, response, 200, {
        source: hasSupabaseConfig() ? 'supabase' : 'none',
        rows,
        updatedAt: new Date().toISOString(),
      }, {
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      }, {
        'Cache-Control': 'no-store',
      })
    }
    return
  }

  if (requestUrl.pathname === '/api/payment-history' && request.method === 'POST') {
    try {
      const payload = await readJsonRequest(request)
      const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 1000) : []

      if (!rows.length) {
        sendJson(request, response, 400, {
          message: 'Expected a rows array to save.',
        }, {
          'Cache-Control': 'no-store',
        })
        return
      }

      const savedRows = await upsertPaymentHistoryRowsToSupabase(rows)
      const historyRows = await loadPaymentHistoryRowsFromSupabase()

      sendJson(request, response, 200, {
        source: hasSupabaseConfig() ? 'supabase' : 'none',
        savedCount: savedRows.length,
        rows: historyRows,
        updatedAt: new Date().toISOString(),
      }, {
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      }, {
        'Cache-Control': 'no-store',
      })
    }
    return
  }

  if (requestUrl.pathname === '/api/stripe/verify-payments' && request.method === 'POST') {
    try {
      const payload = await readJsonRequest(request)
      const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 500) : []

      if (!rows.length) {
        sendJson(request, response, 400, {
          message: 'Expected a rows array to verify.',
        }, {
          'Cache-Control': 'no-store',
        })
        return
      }

      const [results, unrecordedPayments] = await Promise.all([
        verifyStripePaymentRows(rows),
        findStripePaymentsNotInSheet(rows),
      ])

      sendJson(request, response, 200, {
        source: 'stripe',
        rows: results,
        unrecordedPayments,
        updatedAt: new Date().toISOString(),
      }, {
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      }, {
        'Cache-Control': 'no-store',
      })
    }
    return
  }

  if (
    (requestUrl.pathname === '/api/pricing-audit' || requestUrl.pathname === '/api/shopify/pricing-audit')
    && request.method === 'POST'
  ) {
    try {
      const payload = await readJsonRequest(request)
      const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 500) : []

      if (!rows.length) {
        sendJson(request, response, 400, {
          message: 'Expected a rows array to audit.',
        }, {
          'Cache-Control': 'no-store',
        })
        return
      }

      const auditedRows = await auditShopifyPricingRows(rows)

      sendJson(request, response, 200, {
        source: 'local-price-catalog',
        rows: auditedRows,
        updatedAt: new Date().toISOString(),
      }, {
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      }, {
        'Cache-Control': 'no-store',
      })
    }
    return
  }

  if (requestUrl.pathname === '/api/hubspot/call-report' && request.method === 'GET') {
    const selectedDate = requestUrl.searchParams.get('date')
    const forceRefresh = requestUrl.searchParams.get('refresh') === '1'
    const cacheKey = `${callReportCacheVersion}:${selectedDate || 'default'}`
    const cachedReport = reportCache.get(cacheKey)

    if (forceRefresh) {
      reportErrors.delete(cacheKey)
    }

    if (!forceRefresh && cachedReport && Date.now() - cachedReport.cachedAt < (cachedReport.ttlMs ?? currentDateCacheTtlMs)) {
      sendJson(request, response, 200, {
        ...cachedReport.payload,
        cacheSource: 'server-memory',
      }, getApiCacheHeaders(cachedReport.ttlMs ?? currentDateCacheTtlMs))
      return
    }

    const reportError = reportErrors.get(cacheKey)

    if (
      !forceRefresh
      && reportError
      && !inFlightReports.has(cacheKey)
      && Date.now() - new Date(reportError.failedAt).getTime() < callReportErrorTtlMs
    ) {
      sendJson(request, response, 500, {
        message: reportError.message,
        failedAt: reportError.failedAt,
      }, {
        'Cache-Control': 'no-store',
      })
      return
    }

    if (reportError && Date.now() - new Date(reportError.failedAt).getTime() >= callReportErrorTtlMs) {
      reportErrors.delete(cacheKey)
    }

    startCallReportBuild(cacheKey, selectedDate)
    sendJson(request, response, 202, {
      source: 'hubspot',
      status: 'building',
      message: 'HubSpot report is still building. Try again shortly.',
      reportDate: selectedDate ?? null,
      retryAfterMs: 8000,
      rows: [],
      callerAnalytics: [],
      updatedAt: new Date().toISOString(),
    }, {
      'Cache-Control': 'no-store',
      'Retry-After': '8',
    })
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
      sendJson(request, response, 200, {
        ...cachedReport.payload,
        cacheSource: 'server-memory',
      }, getApiCacheHeaders(currentDateCacheTtlMs))
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
      sendJson(request, response, 200, payload, forceRefresh
        ? { 'Cache-Control': 'no-store' }
        : getApiCacheHeaders(currentDateCacheTtlMs))
    } catch (error) {
      sendJson(request, response, 500, {
        message: error.message,
      }, {
        'Cache-Control': 'no-store',
      })
    } finally {
      inFlightTrackingReports.delete(cacheKey)
    }
    return
  }

  sendJson(request, response, 404, {
    message: 'Not found',
  }, {
    'Cache-Control': 'no-store',
  })
})

server.listen(port, host, () => {
  console.log(`HubSpot call report API listening on http://${host}:${port}`)
})

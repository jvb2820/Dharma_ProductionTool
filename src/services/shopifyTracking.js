const sessionCacheKey = 'shopify-tracking-report:v4'
const defaultRowsLimit = 1000
const sessionCacheTtlMs = 5 * 60 * 1000

function getSessionCacheKey(options = {}) {
  const rowsLimit = options.rowsLimit ?? defaultRowsLimit
  const rowsOffset = options.rowsOffset ?? 0

  return `${sessionCacheKey}:${rowsLimit}:${rowsOffset}`
}

function normalizeTrackingRow(row) {
  return {
    rowId: row.rowId ?? row.id ?? row.orderNumber,
    orderNumber: row.orderNumber ?? '',
    suplifulOrder: row.suplifulOrder ?? '',
    item: row.item ?? '',
    name: row.name ?? '',
    phone: row.phone ?? '',
    date: row.date ?? '',
    dateShipped: row.dateShipped ?? '',
    tracking: row.tracking ?? '',
    uspsUrl: row.uspsUrl ?? '',
    deliveryDate: row.deliveryDate ?? '',
    status: row.status ?? '',
    statusSource: row.statusSource ?? '',
    observation: row.observation ?? '',
    financialStatus: row.financialStatus ?? row.financial_status ?? '',
    cancelledAt: row.cancelledAt ?? row.cancelled_at ?? '',
  }
}

function shouldHideTrackingRow(row) {
  const financialStatus = String(row.financialStatus ?? '').toLowerCase()

  return Boolean(row.cancelledAt)
    || financialStatus === 'refunded'
    || financialStatus === 'partially_refunded'
}

function readCachedTracking(options = {}) {
  try {
    const cachedValue = window.sessionStorage.getItem(getSessionCacheKey(options))
    if (!cachedValue) return null

    const cachedEntry = JSON.parse(cachedValue)
    if (
      !cachedEntry?.report
      || !cachedEntry.cachedAt
      || Date.now() - cachedEntry.cachedAt >= sessionCacheTtlMs
    ) {
      window.sessionStorage.removeItem(getSessionCacheKey(options))
      return null
    }

    return cachedEntry.report
  } catch {
    return null
  }
}

function writeCachedTracking(report, options = {}) {
  try {
    window.sessionStorage.setItem(getSessionCacheKey(options), JSON.stringify({
      cachedAt: Date.now(),
      report,
    }))
  } catch {
    // Tracking can still load normally if session storage is unavailable.
  }
}

export async function loadShopifyTracking(options = {}) {
  const endpoint = import.meta.env.VITE_SHOPIFY_TRACKING_URL

  if (!endpoint) {
    return {
      source: 'sample',
      rows: [],
      updatedAt: null,
    }
  }

  const cachedReport = options.forceRefresh || options.skipSessionCache
    ? null
    : readCachedTracking(options)
  if (cachedReport) {
    return {
      ...cachedReport,
      cacheSource: 'session',
    }
  }

  const requestUrl = new URL(endpoint, window.location.origin)
  if (options.forceRefresh) {
    requestUrl.searchParams.set('refresh', '1')
  }
  requestUrl.searchParams.set('rowsLimit', String(options.rowsLimit ?? defaultRowsLimit))
  requestUrl.searchParams.set('rowsOffset', String(options.rowsOffset ?? 0))

  const response = await fetch(requestUrl, {
    cache: options.forceRefresh ? 'no-store' : 'default',
  })

  if (!response.ok) {
    let errorMessage = `Shopify tracking request failed: ${response.status}`

    try {
      const payload = await response.json()
      if (payload?.message) {
        errorMessage = `${errorMessage} - ${payload.message}`
      }
    } catch {
      // Keep the status-only message if the server did not return JSON.
    }

    throw new Error(errorMessage)
  }

  const payload = await response.json()
  const rows = Array.isArray(payload) ? payload : payload.rows ?? payload.results ?? []

  const normalizedRows = rows.map(normalizeTrackingRow).filter((row) => !shouldHideTrackingRow(row))
  const report = {
    source: payload.source ?? 'shopify',
    rows: normalizedRows,
    orderCount: payload.orderCount ?? normalizedRows.length,
    pageCount: payload.pageCount ?? null,
    createdAtMin: payload.createdAtMin ?? null,
    rowsWithStatusCount: payload.rowsWithStatusCount ?? 0,
    rowsWithUspsStatusCount: payload.rowsWithUspsStatusCount ?? 0,
    rowsWithShopifyStatusCount: payload.rowsWithShopifyStatusCount ?? 0,
    rowsWithDeliveryDateCount: payload.rowsWithDeliveryDateCount ?? 0,
    uspsTrackingEnabled: Boolean(payload.uspsTrackingEnabled),
    rowsLimit: payload.rowsLimit ?? options.rowsLimit ?? defaultRowsLimit,
    rowsOffset: payload.rowsOffset ?? options.rowsOffset ?? 0,
    hasMoreRows: Boolean(payload.hasMoreRows),
    updatedAt: payload.updatedAt ?? new Date().toISOString(),
    cacheSource: payload.cacheSource ?? 'network',
  }

  writeCachedTracking(report, options)

  return report
}

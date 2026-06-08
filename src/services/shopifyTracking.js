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

  const requestUrl = new URL(endpoint, window.location.origin)
  if (options.forceRefresh) {
    requestUrl.searchParams.set('refresh', '1')
  }

  const response = await fetch(requestUrl)

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

  return {
    source: payload.source ?? 'shopify',
    rows: rows.map(normalizeTrackingRow),
    orderCount: payload.orderCount ?? rows.length,
    pageCount: payload.pageCount ?? null,
    createdAtMin: payload.createdAtMin ?? null,
    rowsWithStatusCount: payload.rowsWithStatusCount ?? 0,
    rowsWithUspsStatusCount: payload.rowsWithUspsStatusCount ?? 0,
    rowsWithShopifyStatusCount: payload.rowsWithShopifyStatusCount ?? 0,
    rowsWithDeliveryDateCount: payload.rowsWithDeliveryDateCount ?? 0,
    uspsTrackingEnabled: Boolean(payload.uspsTrackingEnabled),
    updatedAt: payload.updatedAt ?? new Date().toISOString(),
  }
}

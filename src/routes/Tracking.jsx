import { useEffect, useMemo, useState } from 'react'
import { loadShopifyTracking } from '../services/shopifyTracking'

const trackingHeaders = [
  'Order Number',
  'Supliful Order',
  'Item',
  'Name',
  'Phone',
  'Date',
  'Date shipped',
  'Tracking',
  'Delivery Date',
  'Status',
]
const overdueDaysThreshold = 5
const trackingAutoRefreshMs = 5 * 60 * 1000
const trackingRowsPageSize = 1000
const trackingBusinessTimeZone = 'America/New_York'
const trackingBusinessDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: trackingBusinessTimeZone,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

function displayCell(value) {
  return value || '-'
}

function renderTrackingNumbers(value, uspsUrl) {
  const trackingNumbers = String(value ?? '')
    .split(',')
    .map((trackingNumber) => trackingNumber.trim())
    .filter(Boolean)

  if (trackingNumbers.length === 0) return '-'

  return trackingNumbers.map((trackingNumber) => (
    <a
      className="tracking-number-link"
      href={uspsUrl || `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`}
      key={trackingNumber}
      rel="noreferrer"
      target="_blank"
    >
      {trackingNumber}
    </a>
  ))
}

function getTrackingStatusClass(value) {
  const normalizedStatus = String(value ?? '').toLowerCase()

  if (normalizedStatus.includes('failed')) return 'failed'
  if (normalizedStatus.includes('delivered')) return 'delivered'
  if (normalizedStatus.includes('transit')) return 'transit'
  if (normalizedStatus.includes('progress')) return 'progress'

  return 'blank'
}

function getStatusSourceLabel(value) {
  if (value === 'usps') return 'Updated from USPS tracking'
  if (value === 'shopify') return 'Updated from Shopify fulfillment status'

  return 'Updated from Google Sheet'
}

function getTrackingSourceLabel(value) {
  if (value === 'supabase') return 'Supabase'
  if (value === 'shopify') return 'Live Shopify'

  return 'Sample'
}

function parseTrackingDate(value) {
  if (!value) return null

  const parts = String(value).trim().split('/').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null

  const [month, day, year] = parts
  const date = new Date(Date.UTC(year, month - 1, day, 12))

  return Number.isNaN(date.getTime()) ? null : date
}

function getTrackingBusinessToday(now = new Date()) {
  const parts = trackingBusinessDateFormatter.formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))

  return new Date(Date.UTC(values.year, values.month - 1, values.day, 12))
}

function countOpenDays(startDate, endDate = getTrackingBusinessToday()) {
  if (!startDate) return 0

  const cursor = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate() + 1,
    12,
  ))
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  let businessDays = 0

  while (cursor.getTime() <= end) {
    const dayOfWeek = cursor.getUTCDay()
    if (dayOfWeek !== 0 && dayOfWeek !== 6) businessDays += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return businessDays
}

function getNormalizedTrackingStatus(value) {
  const status = String(value ?? '').toLowerCase()

  if (status.includes('failed')) return 'failed'
  if (status.includes('delivered')) return 'delivered'
  if (status.includes('transit')) return 'transit'
  if (status.includes('progress')) return 'progress'

  return 'unknown'
}

function getTrackingOrderKey(row) {
  return String(row.orderNumber || row.rowId || '').trim()
}

function getOrderWarningSummary(rows) {
  const ordersByKey = new Map()

  rows.forEach((row) => {
    const orderKey = getTrackingOrderKey(row)
    if (!orderKey) return

    const existingOrder = ordersByKey.get(orderKey)
    const nextOrder = existingOrder ?? {
      ...row,
      failed: false,
      overdue: false,
      active: false,
      businessDaysOpen: 0,
      status: '',
    }

    nextOrder.failed = nextOrder.failed || row.normalizedStatus === 'failed'
    nextOrder.overdue = nextOrder.overdue
      || (row.normalizedStatus !== 'delivered' && row.businessDaysOpen > overdueDaysThreshold)
    nextOrder.active = nextOrder.active
      || (row.normalizedStatus !== 'delivered' && row.normalizedStatus !== 'failed')

    const shouldUseRowDetails = row.normalizedStatus === 'failed'
      || row.businessDaysOpen > nextOrder.businessDaysOpen

    if (shouldUseRowDetails) {
      nextOrder.status = row.status
      nextOrder.statusSource = row.statusSource
      nextOrder.businessDaysOpen = row.businessDaysOpen
      nextOrder.name = row.name
    }

    ordersByKey.set(orderKey, nextOrder)
  })

  const orders = [...ordersByKey.values()]
  const warningOrders = orders
    .filter((order) => order.failed || order.overdue)
    .map((order) => ({
      ...order,
      status: order.failed ? (order.status || 'Failed delivery') : order.status,
    }))
    .sort((left, right) =>
      right.businessDaysOpen - left.businessDaysOpen
      || left.orderNumber.localeCompare(right.orderNumber),
    )

  return {
    activeOrders: orders.filter((order) => order.active),
    failedOrders: orders.filter((order) => order.failed),
    overdueOrders: orders.filter((order) => order.overdue),
    warningOrders,
  }
}

function Tracking() {
  const emptyReport = {
    source: 'shopify',
    rows: [],
    orderCount: 0,
    rowsWithStatusCount: 0,
    rowsLimit: trackingRowsPageSize,
    rowsOffset: 0,
    hasMoreRows: false,
    updatedAt: null,
  }
  const [report, setReport] = useState({
    ...emptyReport,
  })
  const [historyReport, setHistoryReport] = useState({
    ...emptyReport,
    rowsOffset: trackingRowsPageSize,
  })
  const [activeTrackingView, setActiveTrackingView] = useState('recent')
  const [historyPageIndex, setHistoryPageIndex] = useState(0)
  const [status, setStatus] = useState('loading')
  const [historyStatus, setHistoryStatus] = useState('idle')
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const historyRowsOffset = (historyPageIndex + 1) * trackingRowsPageSize
  const activeReport = activeTrackingView === 'history' ? historyReport : report
  const activeStatus = activeTrackingView === 'history' ? historyStatus : status
  const activeError = activeTrackingView === 'history' ? historyError : error

  useEffect(() => {
    let isMounted = true
    let refreshInterval

    const loadTracking = (options = {}) => {
      if (options.showLoading) {
        setStatus('loading')
      }

      return loadShopifyTracking({
        ...options,
        rowsLimit: trackingRowsPageSize,
        rowsOffset: 0,
      })
        .then((data) => {
          if (!isMounted) return
          setReport(data)
          setStatus('ready')
          setError('')
        })
        .catch((loadError) => {
          if (!isMounted) return
          setError(loadError.message)
          setStatus((currentStatus) => (currentStatus === 'ready' ? currentStatus : 'error'))
        })
    }

    loadTracking({ showLoading: true })
    refreshInterval = window.setInterval(() => {
      loadTracking({ skipSessionCache: true })
    }, trackingAutoRefreshMs)

    return () => {
      isMounted = false
      window.clearInterval(refreshInterval)
    }
  }, [])

  useEffect(() => {
    if (activeTrackingView !== 'history') return
    if (historyReport.rows.length > 0 && historyReport.rowsOffset === historyRowsOffset) return

    loadHistoryPage(historyPageIndex)
  }, [activeTrackingView, historyPageIndex, historyReport.rows.length, historyReport.rowsOffset, historyRowsOffset])

  function loadHistoryPage(pageIndex, options = {}) {
    const rowsOffset = (pageIndex + 1) * trackingRowsPageSize

    setHistoryStatus('loading')
    setHistoryError('')

    return loadShopifyTracking({
      ...options,
      rowsLimit: trackingRowsPageSize,
      rowsOffset,
    })
      .then((data) => {
        setHistoryReport(data)
        setHistoryStatus('ready')
      })
      .catch((loadError) => {
        setHistoryError(loadError.message)
        setHistoryStatus('error')
      })
  }

  function refreshTracking() {
    if (activeTrackingView === 'history') {
      loadHistoryPage(historyPageIndex, { forceRefresh: true })
      return
    }

    setStatus('loading')
    setError('')
    loadShopifyTracking({
      forceRefresh: true,
      rowsLimit: trackingRowsPageSize,
      rowsOffset: 0,
    })
      .then((data) => {
        setReport(data)
        setStatus('ready')
      })
      .catch((loadError) => {
        setError(loadError.message)
        setStatus('error')
      })
  }

  function refreshTrackingFromCache() {
    if (activeTrackingView === 'history') {
      loadHistoryPage(historyPageIndex)
      return
    }

    loadShopifyTracking({
      rowsLimit: trackingRowsPageSize,
      rowsOffset: 0,
    })
      .then((data) => {
        setReport(data)
        setStatus('ready')
        setError('')
      })
      .catch((loadError) => {
        setError(loadError.message)
        setStatus('error')
      })
  }

  const analytics = useMemo(() => {
    const statusGroups = {
      delivered: { label: 'Delivered', count: 0, className: 'delivered' },
      failed: { label: 'Failed', count: 0, className: 'failed' },
      transit: { label: 'In transit', count: 0, className: 'transit' },
      progress: { label: 'In progress', count: 0, className: 'progress' },
      unknown: { label: 'No status', count: 0, className: 'unknown' },
    }
    const rowsWithAge = activeReport.rows.map((row) => {
      const normalizedStatus = getNormalizedTrackingStatus(row.status)
      const ageStartDate = parseTrackingDate(row.date)
      const daysOpen = normalizedStatus === 'delivered'
        ? 0
        : countOpenDays(ageStartDate)

      statusGroups[normalizedStatus].count += 1

      return {
        ...row,
        normalizedStatus,
        businessDaysOpen: daysOpen,
      }
    })
    const warningSummary = getOrderWarningSummary(rowsWithAge)
    const maxStatusCount = Math.max(...Object.values(statusGroups).map((group) => group.count), 1)

    return {
      statusGroups: Object.values(statusGroups),
      maxStatusCount,
      ...warningSummary,
    }
  }, [activeReport.rows])

  return (
    <section className="route-view" aria-label="Tracking dashboard">
      <div className="report-toolbar">
        <div>
          <h1>Tracking</h1>
          <p>Shopify order shipping details.</p>
        </div>
      </div>

      <div className="report-filters" aria-label="Tracking actions">
        <span className="filter-label">{getTrackingSourceLabel(activeReport.source)}</span>
        <span className="timezone-pill">{activeReport.uspsTrackingEnabled ? 'USPS live enabled' : 'USPS links only'}</span>
        <button
          className="filter-button"
          disabled={activeStatus === 'loading'}
          type="button"
          onClick={refreshTrackingFromCache}
        >
          Refresh
        </button>
        <button
          className="filter-button"
          disabled={activeStatus === 'loading'}
          type="button"
          onClick={refreshTracking}
        >
          Refresh Live
        </button>
      </div>

      <nav className="home-view-tabs tracking-view-tabs" aria-label="Tracking views">
        <button
          type="button"
          className={activeTrackingView === 'recent' ? 'active' : ''}
          onClick={() => setActiveTrackingView('recent')}
        >
          <span>Recent</span>
          <strong>{report.rows.length}</strong>
        </button>
        <button
          type="button"
          className={activeTrackingView === 'history' ? 'active' : ''}
          onClick={() => setActiveTrackingView('history')}
        >
          <span>History</span>
          <strong>{historyReport.rows.length}</strong>
        </button>
      </nav>

      {activeStatus === 'error' && <div className="report-alert">{activeError}</div>}

      {activeStatus !== 'loading' && (
        <section className="tracking-analytics" aria-label="Tracking analytics">
          <div className="tracking-analytics-hero">
            <div>
              <span>Delivery Risk</span>
              <strong>{analytics.overdueOrders.length}</strong>
              <small>
                Open orders over
                {' '}
                {overdueDaysThreshold}
                {' '}
                business days
              </small>
            </div>
            <div className="tracking-risk-graphic" aria-hidden="true">
              <div className="tracking-risk-pulse">
                <span />
                <span />
                <strong>!</strong>
              </div>
              <div className="tracking-risk-stripes" />
            </div>
            <div className="tracking-risk-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, analytics.overdueOrders.length * 8)}%` }} />
            </div>
          </div>

          <div className="tracking-analytics-grid">
            <article className="tracking-chart-card">
              <div className="tracking-card-heading">
                <h2>Status Overview</h2>
                <span>{activeReport.rows.length} rows</span>
              </div>
              <div className="tracking-status-chart">
                {analytics.statusGroups.map((group) => (
                  <div className="tracking-chart-row" key={group.className}>
                    <div>
                      <span>{group.label}</span>
                      <strong>{group.count}</strong>
                    </div>
                    <div className={`tracking-chart-bar ${group.className}`}>
                      <span style={{ width: `${(group.count / analytics.maxStatusCount) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="tracking-warning-card">
              <div className="tracking-card-heading">
                <h2>Warnings</h2>
                <span>{analytics.warningOrders.length} orders</span>
              </div>
              <div className="tracking-warning-summary">
                <span>
                  <strong>{analytics.failedOrders.length}</strong>
                  Failed delivery
                </span>
                <span>
                  <strong>{analytics.activeOrders.length}</strong>
                  Open orders
                </span>
                <span>
                  <strong>{analytics.overdueOrders.length}</strong>
                  Overdue
                </span>
              </div>
              <div className="tracking-warning-list">
                {analytics.warningOrders.length === 0 && (
                  <div className="tracking-warning-empty">No overdue or failed deliveries found.</div>
                )}
                {analytics.warningOrders.map((row) => (
                  <div className="tracking-warning-item" key={`${getTrackingOrderKey(row)}-warning`}>
                    <div>
                      <strong>{row.orderNumber}</strong>
                      <span>{row.name || 'No name'}</span>
                    </div>
                    <div>
                      <span className={`tracking-status ${getTrackingStatusClass(row.status)}`}>
                        {row.status || 'No status'}
                      </span>
                      <small>
                        {row.businessDaysOpen}
                        {' '}
                        business days
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>
      )}

      <div className="table-panel tracking-panel">
        {activeTrackingView === 'history' && (
          <div className="tracking-history-controls">
            <div>
              <strong>
                Rows
                {' '}
                {historyRowsOffset + 1}
                -
                {historyRowsOffset + historyReport.rows.length}
              </strong>
              <span>Showing older tracking records in batches of {trackingRowsPageSize}</span>
            </div>
            <div>
              <button
                className="filter-button"
                disabled={historyStatus === 'loading' || historyPageIndex === 0}
                type="button"
                onClick={() => setHistoryPageIndex((currentPage) => Math.max(0, currentPage - 1))}
              >
                Newer
              </button>
              <button
                className="filter-button"
                disabled={historyStatus === 'loading' || !historyReport.hasMoreRows}
                type="button"
                onClick={() => setHistoryPageIndex((currentPage) => currentPage + 1)}
              >
                Older
              </button>
            </div>
          </div>
        )}
        <div className="table-shell">
          <table className="client-table tracking-table">
            <thead>
              <tr className="tracking-title-row">
                <th colSpan={trackingHeaders.length} scope="colgroup">
                  Shopify Tracking Dashboard
                </th>
              </tr>
              <tr>
                {trackingHeaders.map((header) => (
                  <th scope="col" key={header}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeStatus === 'loading' && (
                <tr className="empty-row">
                  <td colSpan={trackingHeaders.length}>Loading Shopify orders...</td>
                </tr>
              )}
              {activeStatus !== 'loading' && activeReport.rows.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={trackingHeaders.length}>No Shopify orders found</td>
                </tr>
              )}
              {activeStatus !== 'loading' && activeReport.rows.map((row) => (
                <tr key={row.rowId}>
                  <td className="tracking-order-cell">{displayCell(row.orderNumber)}</td>
                  <td>{displayCell(row.suplifulOrder)}</td>
                  <td title={row.item}>{displayCell(row.item)}</td>
                  <td>{displayCell(row.name)}</td>
                  <td>{displayCell(row.phone)}</td>
                  <td>{displayCell(row.date)}</td>
                  <td>{displayCell(row.dateShipped)}</td>
                  <td title={row.tracking}>{renderTrackingNumbers(row.tracking, row.uspsUrl)}</td>
                  <td>{displayCell(row.deliveryDate)}</td>
                  <td>
                    {row.status ? (
                      <span
                        className={`tracking-status ${getTrackingStatusClass(row.status)}`}
                        title={getStatusSourceLabel(row.statusSource)}
                      >
                        {row.status}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

export default Tracking

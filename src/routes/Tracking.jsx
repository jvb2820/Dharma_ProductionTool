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
const overdueBusinessDaysThreshold = 7

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
  const date = new Date(year, month - 1, day)

  return Number.isNaN(date.getTime()) ? null : date
}

function countBusinessDays(startDate, endDate = new Date()) {
  if (!startDate) return 0

  const current = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
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

function getNormalizedTrackingStatus(value) {
  const status = String(value ?? '').toLowerCase()

  if (status.includes('failed')) return 'failed'
  if (status.includes('delivered')) return 'delivered'
  if (status.includes('transit')) return 'transit'
  if (status.includes('progress')) return 'progress'

  return 'unknown'
}

function Tracking() {
  const [report, setReport] = useState({
    source: 'shopify',
    rows: [],
    orderCount: 0,
    rowsWithStatusCount: 0,
    updatedAt: null,
  })
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let isMounted = true

    loadShopifyTracking()
      .then((data) => {
        if (!isMounted) return
        setReport(data)
        setStatus('ready')
      })
      .catch((loadError) => {
        if (!isMounted) return
        setError(loadError.message)
        setStatus('error')
      })

    return () => {
      isMounted = false
    }
  }, [])

  function refreshTracking() {
    setStatus('loading')
    setError('')

    loadShopifyTracking({ forceRefresh: true })
      .then((data) => {
        setReport(data)
        setStatus('ready')
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
    const rowsWithAge = report.rows.map((row) => {
      const normalizedStatus = getNormalizedTrackingStatus(row.status)
      const ageStartDate = parseTrackingDate(row.dateShipped || row.date)
      const businessDaysOpen = normalizedStatus === 'delivered'
        ? 0
        : countBusinessDays(ageStartDate)

      statusGroups[normalizedStatus].count += 1

      return {
        ...row,
        normalizedStatus,
        businessDaysOpen,
      }
    })
    const overdueRows = rowsWithAge
      .filter((row) => row.normalizedStatus !== 'delivered' && row.businessDaysOpen > overdueBusinessDaysThreshold)
      .sort((left, right) => right.businessDaysOpen - left.businessDaysOpen)
    const warningRows = rowsWithAge
      .filter((row) =>
        row.normalizedStatus === 'failed'
        || (row.normalizedStatus !== 'delivered' && row.businessDaysOpen > overdueBusinessDaysThreshold),
      )
      .sort((left, right) =>
        right.businessDaysOpen - left.businessDaysOpen
        || left.orderNumber.localeCompare(right.orderNumber),
      )
    const activeRows = rowsWithAge.filter((row) =>
      row.normalizedStatus !== 'delivered' && row.normalizedStatus !== 'failed',
    )
    const maxStatusCount = Math.max(...Object.values(statusGroups).map((group) => group.count), 1)

    return {
      statusGroups: Object.values(statusGroups),
      maxStatusCount,
      overdueRows,
      warningRows,
      failedRows: rowsWithAge.filter((row) => row.normalizedStatus === 'failed'),
      activeRows,
    }
  }, [report.rows])

  return (
    <section className="route-view" aria-label="Tracking dashboard">
      <div className="report-toolbar">
        <div>
          <h1>Tracking</h1>
          <p>Shopify order shipping details.</p>
        </div>
      </div>

      <div className="report-filters" aria-label="Tracking actions">
        <span className="filter-label">{getTrackingSourceLabel(report.source)}</span>
        <span className="timezone-pill">{report.uspsTrackingEnabled ? 'USPS live enabled' : 'USPS links only'}</span>
        <button
          className="filter-button"
          disabled={status === 'loading'}
          type="button"
          onClick={refreshTracking}
        >
          Refresh
        </button>
      </div>

      {status === 'error' && <div className="report-alert">{error}</div>}

      {status !== 'loading' && (
        <section className="tracking-analytics" aria-label="Tracking analytics">
          <div className="tracking-analytics-hero">
            <div>
              <span>Delivery Risk</span>
              <strong>{analytics.overdueRows.length}</strong>
              <small>
                Open shipments over
                {' '}
                {overdueBusinessDaysThreshold}
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
              <span style={{ width: `${Math.min(100, analytics.overdueRows.length * 8)}%` }} />
            </div>
          </div>

          <div className="tracking-analytics-grid">
            <article className="tracking-chart-card">
              <div className="tracking-card-heading">
                <h2>Status Overview</h2>
                <span>{report.rows.length} rows</span>
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
                <span>{analytics.warningRows.length} items</span>
              </div>
              <div className="tracking-warning-summary">
                <span>
                  <strong>{analytics.failedRows.length}</strong>
                  Failed delivery
                </span>
                <span>
                  <strong>{analytics.activeRows.length}</strong>
                  Open packages
                </span>
                <span>
                  <strong>{analytics.overdueRows.length}</strong>
                  Overdue
                </span>
              </div>
              <div className="tracking-warning-list">
                {analytics.warningRows.length === 0 && (
                  <div className="tracking-warning-empty">No overdue or failed deliveries found.</div>
                )}
                {analytics.warningRows.map((row) => (
                  <div className="tracking-warning-item" key={`${row.rowId}-warning`}>
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
              {status === 'loading' && (
                <tr className="empty-row">
                  <td colSpan={trackingHeaders.length}>Loading Shopify orders...</td>
                </tr>
              )}
              {status !== 'loading' && report.rows.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={trackingHeaders.length}>No Shopify orders found</td>
                </tr>
              )}
              {status !== 'loading' && report.rows.map((row) => (
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

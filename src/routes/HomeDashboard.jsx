import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { loadPaymentHistory, savePaymentHistory } from '../services/paymentHistory'
import { verifyStripePayments } from '../services/stripePaymentVerification'

const tableHeaders = [
  'Date',
  'Total Collected',
  'Tender Note',
  'Staff Name',
  'Description',
  'Customer Name',
  'Discount Name',
  'Verification',
  'Dharma Orders',
]

const manualHeaders = ['Dharma Orders', 'Verification']
const uploadHeaders = tableHeaders.filter((header) => !manualHeaders.includes(header))

const uploadHeaderAliases = {
  Date: ['Paid Date', 'Paid Date All Pipelines', 'Paid Date (All Pipelines)'],
  'Total Collected': ['Amount'],
  'Tender Note': ['Payment Note', 'Payment Notes'],
  'Staff Name': ['Deal Owner'],
  Description: ['Deal Description', 'Deal Description Aggregate', 'Deal Description (Aggregate)'],
  'Customer Name': ['Associated Contact', 'Associated Contacts'],
  'Discount Name': ['Deal', 'Deals', 'Count Deals', '(Count) Deals', 'Discount'],
}

const normalizeHeader = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const uploadHeaderOptions = uploadHeaders.map((header) =>
  [header, ...(uploadHeaderAliases[header] ?? [])].map((option) => normalizeHeader(option)),
)

function parseMoney(value) {
  const amount = Number(String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, ''))

  return Number.isFinite(amount) ? amount : 0
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value)
}

function getVerificationClass(value) {
  if (value === 'Yes') return 'verified'
  if (value === 'No') return 'missing'

  return 'pending'
}

function getManualSelectClass(value) {
  if (value === 'Yes') return 'verified'
  if (value === 'No') return 'missing'

  return 'pending'
}

function dateValueToIso(value) {
  const rawValue = String(value ?? '').trim()
  if (!rawValue) return ''

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
    if (Number.isNaN(parsedDate.getTime())) return ''

    year = parsedDate.getFullYear()
    month = parsedDate.getMonth() + 1
    day = parsedDate.getDate()
  }

  const date = new Date(Date.UTC(year, month - 1, day, 12))
  if (Number.isNaN(date.getTime())) return ''

  return date.toISOString().slice(0, 10)
}

function getYesterdayEdtDateValue() {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const todayParts = formatter.formatToParts(now)
  const part = (type) => todayParts.find((item) => item.type === type)?.value ?? ''
  const todayUtc = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')), 12))

  todayUtc.setUTCDate(todayUtc.getUTCDate() - 1)

  return todayUtc.toISOString().slice(0, 10)
}

function getUniquePaymentDates(rows) {
  return [...new Set(rows.map((row) => dateValueToIso(row.Date)).filter(Boolean))]
}

function formatAuditPaymentDates(dates) {
  if (!dates.length) return 'uploaded payment date'
  if (dates.length === 1) return `${dates[0]} EDT`

  return `${dates.length} uploaded EDT dates`
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes <= 0) return `${seconds}s`

  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function estimateVerificationDurationMs(rowCount, paymentDateCount) {
  return Math.max(15000, rowCount * 450 + Math.max(paymentDateCount, 1) * 5000)
}

function getRowsFromWorkbook(workbook) {
  return workbook.SheetNames.flatMap((sheetName) => {
    const worksheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      raw: false,
    })

    const headerRowIndex = rows.findIndex((row) => {
      const rowHeaders = row.map((cell) => normalizeHeader(cell))

      return uploadHeaderOptions.filter((options) => options.some((header) => rowHeaders.includes(header))).length >= 2
    })

    if (headerRowIndex === -1) {
      return []
    }

    const headerRow = rows[headerRowIndex].map((cell) => normalizeHeader(cell))
    const columnIndexes = uploadHeaderOptions.map((options) =>
      headerRow.findIndex((header) => options.includes(header)),
    )

    return rows.slice(headerRowIndex + 1).reduce((records, row) => {
      const record = uploadHeaders.reduce((currentRecord, header, index) => {
        const columnIndex = columnIndexes[index]
        currentRecord[header] = columnIndex === -1 ? '' : String(row[columnIndex] ?? '').trim()
        return currentRecord
      }, {})

      record.Verification = ''
      record['Dharma Orders'] = ''

      const hasDashboardValue = uploadHeaders.some((header) => record[header])

      return hasDashboardValue ? [...records, record] : records
    }, [])
  })
}

function HomeDashboard() {
  const [records, setRecords] = useState([])
  const [historyRecords, setHistoryRecords] = useState([])
  const [activeHomeView, setActiveHomeView] = useState('verification')
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadedFileName, setUploadedFileName] = useState('')
  const [unrecordedPayments, setUnrecordedPayments] = useState([])
  const [hasCheckedUnrecordedPayments, setHasCheckedUnrecordedPayments] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [verificationStartedAt, setVerificationStartedAt] = useState(null)
  const [verificationTick, setVerificationTick] = useState(0)
  const [isHistoryLoading, setIsHistoryLoading] = useState(true)
  const [historyDate, setHistoryDate] = useState(() => getYesterdayEdtDateValue())

  const analytics = useMemo(() => {
    const verifiedRows = records.filter((record) => record.Verification === 'Yes')
    const missingRows = records.filter((record) => record.Verification === 'No')
    const pendingRows = records.filter((record) => !record.Verification)
    const totalCollected = records.reduce((total, record) => total + parseMoney(record['Total Collected']), 0)
    const verifiedAmount = verifiedRows.reduce((total, record) => total + parseMoney(record['Total Collected']), 0)
    const maxCount = Math.max(verifiedRows.length, missingRows.length, pendingRows.length, 1)

    return {
      totalCollected,
      verifiedAmount,
      verifiedRows,
      missingRows,
      pendingRows,
      maxCount,
    }
  }, [records])

  const filteredHistoryRecords = useMemo(() => (
    historyRecords.filter((record) => {
      const paymentDate = dateValueToIso(record.Date)

      return paymentDate === historyDate
    })
  ), [historyDate, historyRecords])

  const historyAnalytics = useMemo(() => {
    const verifiedRows = filteredHistoryRecords.filter((record) => record.Verification === 'Yes')
    const missingRows = filteredHistoryRecords.filter((record) => record.Verification === 'No')
    const pendingRows = filteredHistoryRecords.filter((record) => !record.Verification)
    const totalCollected = filteredHistoryRecords.reduce(
      (total, record) => total + parseMoney(record['Total Collected']),
      0,
    )
    const verifiedAmount = verifiedRows.reduce(
      (total, record) => total + parseMoney(record['Total Collected']),
      0,
    )

    return {
      totalCollected,
      verifiedAmount,
      verifiedRows,
      missingRows,
      pendingRows,
    }
  }, [filteredHistoryRecords])

  const uploadedPaymentDates = useMemo(() => getUniquePaymentDates(records), [records])
  const auditPaymentDateLabel = formatAuditPaymentDates(uploadedPaymentDates)
  const verificationProgress = useMemo(() => {
    if (!isVerifying || !verificationStartedAt) {
      return {
        elapsedMs: 0,
        estimatedMs: 0,
        remainingMs: 0,
        percent: 0,
      }
    }

    const estimatedMs = estimateVerificationDurationMs(records.length, uploadedPaymentDates.length)
    const elapsedMs = Math.max(0, verificationTick - verificationStartedAt)

    return {
      elapsedMs,
      estimatedMs,
      remainingMs: Math.max(0, estimatedMs - elapsedMs),
      percent: Math.min(96, Math.max(8, Math.round((elapsedMs / estimatedMs) * 100))),
    }
  }, [isVerifying, records.length, uploadedPaymentDates.length, verificationStartedAt, verificationTick])

  useEffect(() => {
    let isCurrent = true

    loadPaymentHistory()
      .then((rows) => {
        if (isCurrent) {
          setHistoryRecords(rows)
        }
      })
      .catch((error) => {
        if (isCurrent) {
          setUploadMessage(error.message || 'Could not load payment history.')
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsHistoryLoading(false)
        }
      })

    return () => {
      isCurrent = false
    }
  }, [])

  useEffect(() => {
    if (!isVerifying) return undefined

    const intervalId = window.setInterval(() => {
      setVerificationTick(Date.now())
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [isVerifying])

  const handleFileUpload = async (event) => {
    const [file] = event.target.files

    if (!file) {
      return
    }

    setUploadMessage(`Reading ${file.name}...`)
    setUploadedFileName('')
    setUnrecordedPayments([])
    setHasCheckedUnrecordedPayments(false)
    setIsVerifying(false)
    setVerificationStartedAt(null)

    try {
      const fileBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(fileBuffer, { type: 'array', cellDates: true })
      const nextRecords = getRowsFromWorkbook(workbook)

      setRecords(nextRecords)
      setUploadedFileName(file.name)
      if (!nextRecords.length) {
        setUploadMessage(`No matching dashboard headers were found in ${file.name}.`)
        return
      }

      try {
        const historyRows = await savePaymentHistory(nextRecords)
        setHistoryRecords(historyRows)
        setUploadMessage(
          `Loaded and saved ${nextRecords.length} row${nextRecords.length === 1 ? '' : 's'} from ${file.name}.`,
        )
      } catch (historyError) {
        setUploadMessage(
          `Loaded ${nextRecords.length} row${nextRecords.length === 1 ? '' : 's'} from ${file.name}, but history save failed: ${historyError.message || 'Could not reach the API.'}`,
        )
      }
    } catch (error) {
      setRecords([])
      setUploadMessage(error.message || 'Could not read that file. Please upload a valid CSV, XLS, or XLSX file.')
      console.error(error)
    }
  }

  const handleVerifyPayments = async () => {
    if (!records.length || isVerifying) {
      return
    }

    setIsVerifying(true)
    setVerificationStartedAt(Date.now())
    setVerificationTick(Date.now())
    setUploadMessage(`Verifying ${records.length} row${records.length === 1 ? '' : 's'} in Stripe...`)

    try {
      const recordsToVerify = records.map((record) => ({
        ...record,
        Verification: '',
      }))
      const verificationResult = await verifyStripePayments(recordsToVerify)
      const verificationRows = verificationResult.rows
      const verifiedRecords = recordsToVerify.map((record, index) => ({
        ...record,
        Verification: verificationRows[index]?.verification === 'Yes' ? 'Yes' : 'No',
      }))
      const historyRows = await savePaymentHistory(verifiedRecords)

      setRecords(verifiedRecords)
      setHistoryRecords(historyRows)
      setUnrecordedPayments(verificationResult.unrecordedPayments)
      setHasCheckedUnrecordedPayments(true)
      setUploadMessage(
        `Stripe verification complete for ${verifiedRecords.length} row${verifiedRecords.length === 1 ? '' : 's'}${uploadedFileName ? ` from ${uploadedFileName}` : ''}.`,
      )
    } catch (error) {
      setUploadMessage(error.message || 'Stripe verification failed. Please check the Stripe key and try again.')
      console.error(error)
    } finally {
      setIsVerifying(false)
      setVerificationStartedAt(null)
    }
  }

  const handleManualVerificationChange = async (rowIndex, verification) => {
    const updatedRecord = {
      ...records[rowIndex],
      Verification: verification,
    }

    setRecords((currentRecords) =>
      currentRecords.map((record, index) => (index === rowIndex ? updatedRecord : record)),
    )

    try {
      const historyRows = await savePaymentHistory([updatedRecord])
      setHistoryRecords(historyRows)
      setUploadMessage('Manual verification saved to history.')
    } catch (error) {
      setUploadMessage(error.message || 'Could not save manual verification.')
    }
  }

  const handleManualDharmaOrdersChange = async (rowIndex, dharmaOrders) => {
    const updatedRecord = {
      ...records[rowIndex],
      'Dharma Orders': dharmaOrders,
    }

    setRecords((currentRecords) =>
      currentRecords.map((record, index) => (index === rowIndex ? updatedRecord : record)),
    )

    try {
      const historyRows = await savePaymentHistory([updatedRecord])
      setHistoryRecords(historyRows)
      setUploadMessage('Dharma Orders saved to history.')
    } catch (error) {
      setUploadMessage(error.message || 'Could not save Dharma Orders.')
    }
  }

  const handleHistoryVerificationChange = async (rowIndex, verification) => {
    const updatedRecord = {
      ...filteredHistoryRecords[rowIndex],
      Verification: verification,
    }

    setHistoryRecords((currentRecords) =>
      currentRecords.map((record) => (record.rowId === updatedRecord.rowId ? updatedRecord : record)),
    )

    try {
      const historyRows = await savePaymentHistory([updatedRecord])
      setHistoryRecords(historyRows)
      setUploadMessage('History verification updated.')
    } catch (error) {
      setUploadMessage(error.message || 'Could not update history verification.')
    }
  }

  const handleHistoryDharmaOrdersChange = async (rowIndex, dharmaOrders) => {
    const updatedRecord = {
      ...filteredHistoryRecords[rowIndex],
      'Dharma Orders': dharmaOrders,
    }

    setHistoryRecords((currentRecords) =>
      currentRecords.map((record) => (record.rowId === updatedRecord.rowId ? updatedRecord : record)),
    )

    try {
      const historyRows = await savePaymentHistory([updatedRecord])
      setHistoryRecords(historyRows)
      setUploadMessage('History Dharma Orders updated.')
    } catch (error) {
      setUploadMessage(error.message || 'Could not update history Dharma Orders.')
    }
  }

  const resetHistoryDateFilter = () => {
    setHistoryDate(getYesterdayEdtDateValue())
  }

  return (
    <section className="route-view" aria-label="Home dashboard">
      <div className="report-toolbar home-toolbar">
        <div>
          <h1>Payment Verification</h1>
          <p>Upload production data and match collected payments in Stripe.</p>
        </div>
        <div className="report-stats">
          <span>
            <strong>{records.length}</strong>
            Rows
          </span>
          <span>
            <strong>{analytics.verifiedRows.length}</strong>
            Verified
          </span>
          <span>
            <strong>{analytics.missingRows.length}</strong>
            Missing
          </span>
        </div>
      </div>

      <div className="home-dashboard-shell">
        <nav className="home-view-tabs" aria-label="Home dashboard views">
          <button
            type="button"
            className={activeHomeView === 'verification' ? 'active' : ''}
            onClick={() => setActiveHomeView('verification')}
          >
            <span>Payment Verification</span>
            <strong>{records.length}</strong>
          </button>
          <button
            type="button"
            className={activeHomeView === 'history' ? 'active' : ''}
            onClick={() => setActiveHomeView('history')}
          >
            <span>History</span>
            <strong>{filteredHistoryRecords.length}</strong>
          </button>
        </nav>

        <div className="home-view-content">
          {activeHomeView === 'verification' ? (
            <>
              <div className="home-workspace">
                <div className="upload-panel home-upload-panel">
                  <label className="file-upload" htmlFor="client-file-upload">
                    <span className="upload-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M12 16V5" />
                        <path d="m8 9 4-4 4 4" />
                        <path d="M5 15v4h14v-4" />
                      </svg>
                    </span>
                    <span>
                      <strong>Upload client file</strong>
                      <small>CSV, XLS, or XLSX</small>
                    </span>
                  </label>
                  <input id="client-file-upload" type="file" accept=".csv,.xls,.xlsx" onChange={handleFileUpload} />
                  {records.length ? (
                    <div className="upload-actions">
                      <button className="verify-button" type="button" onClick={handleVerifyPayments} disabled={isVerifying}>
                        {isVerifying ? 'Verifying...' : 'Verify'}
                      </button>
                    </div>
                  ) : null}
                  {isVerifying ? (
                    <div className="verification-loader" role="status" aria-live="polite">
                      <div className="verification-loader-heading">
                        <span>Checking Stripe payments</span>
                        <strong>{verificationProgress.percent}%</strong>
                      </div>
                      <div className="verification-loader-bar" aria-hidden="true">
                        <span style={{ width: `${verificationProgress.percent}%` }} />
                      </div>
                      <div className="verification-loader-meta">
                        <span>Elapsed {formatDuration(verificationProgress.elapsedMs)}</span>
                        <span>ETA {formatDuration(verificationProgress.remainingMs)}</span>
                      </div>
                    </div>
                  ) : null}
                  {uploadMessage ? <p className="upload-message">{uploadMessage}</p> : null}
                </div>

                <section className="home-analytics" aria-label="Payment analytics">
                  <article className="home-total-card">
                    <span>Total Collected</span>
                    <strong>{formatMoney(analytics.totalCollected)}</strong>
                    <small>{uploadedFileName || 'No file uploaded'}</small>
                  </article>
                  <article className="tracking-chart-card home-chart-card">
                    <div className="tracking-card-heading">
                      <h2>Stripe Verification</h2>
                      <span>{records.length} rows</span>
                    </div>
                    <div className="tracking-status-chart">
                      <div className="tracking-chart-row">
                        <div>
                          <span>Verified</span>
                          <strong>{analytics.verifiedRows.length}</strong>
                        </div>
                        <div className="tracking-chart-bar delivered">
                          <span style={{ width: `${(analytics.verifiedRows.length / analytics.maxCount) * 100}%` }} />
                        </div>
                      </div>
                      <div className="tracking-chart-row">
                        <div>
                          <span>Not found</span>
                          <strong>{analytics.missingRows.length}</strong>
                        </div>
                        <div className="tracking-chart-bar failed">
                          <span style={{ width: `${(analytics.missingRows.length / analytics.maxCount) * 100}%` }} />
                        </div>
                      </div>
                      <div className="tracking-chart-row">
                        <div>
                          <span>Pending</span>
                          <strong>{analytics.pendingRows.length}</strong>
                        </div>
                        <div className="tracking-chart-bar unknown">
                          <span style={{ width: `${(analytics.pendingRows.length / analytics.maxCount) * 100}%` }} />
                        </div>
                      </div>
                    </div>
                  </article>
                  <article className="home-verification-card">
                    <span>Verified Amount</span>
                    <strong>{formatMoney(analytics.verifiedAmount)}</strong>
                    <small>{analytics.missingRows.length} rows still unmatched</small>
                  </article>
                </section>
              </div>

              {hasCheckedUnrecordedPayments ? (
                <section className="unrecorded-payments-panel" aria-label="Payments not in uploaded sheet">
                  <div className="unrecorded-payments-heading">
                    <div>
                      <h2>Payments Not In Sheet</h2>
                      <p>Checked all Stripe paid charges for {auditPaymentDateLabel} against this uploaded sheet.</p>
                    </div>
                    <strong>{unrecordedPayments.length}</strong>
                  </div>
                  {unrecordedPayments.length ? (
                    <div className="unrecorded-payments-table-shell">
                      <table className="unrecorded-payments-table">
                        <thead>
                          <tr>
                            <th scope="col">Email</th>
                            <th scope="col">Name</th>
                            <th scope="col">Phone Number</th>
                            <th scope="col">Price</th>
                            <th scope="col">Date</th>
                            <th scope="col">State</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unrecordedPayments.map((payment) => (
                            <tr key={payment.id}>
                              <td>{payment.customerEmail || '-'}</td>
                              <td>{payment.customerName || '-'}</td>
                              <td>{payment.customerPhone || '-'}</td>
                              <td>{payment.amount || '-'}</td>
                              <td>{payment.createdAt || payment.paymentDate || '-'}</td>
                              <td>{payment.customerState || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="unrecorded-payments-empty">
                      No Unrecorded Payment Found for {auditPaymentDateLabel}.
                    </p>
                  )}
                </section>
              ) : null}

              <div className="table-panel tracking-panel home-table-panel">
                <div className="table-shell">
                  <table className="client-table tracking-table home-table">
                    <thead>
                      <tr className="tracking-title-row">
                        <th colSpan={tableHeaders.length} scope="colgroup">
                          Production Payment Dashboard
                        </th>
                      </tr>
                      <tr>
                        {tableHeaders.map((header) => (
                          <th scope="col" key={header}>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {records.length ? (
                        records.map((record, rowIndex) => (
                          <tr key={`${record.Date}-${record['Customer Name']}-${rowIndex}`}>
                            {tableHeaders.map((header) => (
                              <td key={header}>
                                {header === 'Verification' ? (
                                  <select
                                    aria-label={`Verification for ${record['Customer Name'] || `row ${rowIndex + 1}`}`}
                                    className={`verification-select ${getVerificationClass(record[header])}`}
                                    value={record[header] || ''}
                                    onChange={(event) => handleManualVerificationChange(rowIndex, event.target.value)}
                                  >
                                    <option value="">Pending</option>
                                    <option value="Yes">Yes</option>
                                    <option value="No">No</option>
                                  </select>
                                ) : header === 'Dharma Orders' ? (
                                  <select
                                    aria-label={`Dharma Orders for ${record['Customer Name'] || `row ${rowIndex + 1}`}`}
                                    className={`verification-select ${getManualSelectClass(record[header])}`}
                                    value={record[header] || ''}
                                    onChange={(event) => handleManualDharmaOrdersChange(rowIndex, event.target.value)}
                                  >
                                    <option value="">-</option>
                                    <option value="Yes">Yes</option>
                                    <option value="No">No</option>
                                  </select>
                                ) : (
                                  record[header] || '-'
                                )}
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : (
                        <tr className="empty-row">
                          <td colSpan={tableHeaders.length}>No records yet</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <>
              <section className="history-analytics" aria-label="Payment history analytics">
                <article className="history-summary-card">
                  <span>Total Collected</span>
                  <strong>{formatMoney(historyAnalytics.totalCollected)}</strong>
                  <small>{filteredHistoryRecords.length} rows on selected date</small>
                </article>
                <article className="history-summary-card verified">
                  <span>Verified Amount</span>
                  <strong>{formatMoney(historyAnalytics.verifiedAmount)}</strong>
                  <small>{historyAnalytics.verifiedRows.length} verified rows</small>
                </article>
                <article className="history-summary-card">
                  <span>Verification Status</span>
                  <div className="history-status-stack">
                    <p>
                      <strong>{historyAnalytics.verifiedRows.length}</strong>
                      Verified
                    </p>
                    <p>
                      <strong>{historyAnalytics.missingRows.length}</strong>
                      Not found
                    </p>
                    <p>
                      <strong>{historyAnalytics.pendingRows.length}</strong>
                      Pending
                    </p>
                  </div>
                </article>
              </section>

              <div className="table-panel tracking-panel home-table-panel payment-history-panel">
                <div className="payment-history-controls" aria-label="Payment history date filters">
                  <div>
                    <strong>Payment History</strong>
                    <span>
                      {filteredHistoryRecords.length} of {historyRecords.length} rows
                    </span>
                  </div>
                  <label>
                    Payment Date
                    <input
                      type="date"
                      value={historyDate}
                      onChange={(event) => setHistoryDate(event.target.value)}
                    />
                  </label>
                  <button type="button" onClick={resetHistoryDateFilter} disabled={historyDate === getYesterdayEdtDateValue()}>
                    Yesterday EDT
                  </button>
                </div>
                <div className="table-shell">
                  <table className="client-table tracking-table home-table">
                    <thead>
                      <tr className="tracking-title-row">
                        <th colSpan={tableHeaders.length} scope="colgroup">
                          Payment History
                        </th>
                      </tr>
                      <tr>
                        {tableHeaders.map((header) => (
                          <th scope="col" key={header}>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredHistoryRecords.length ? (
                        filteredHistoryRecords.map((record, rowIndex) => (
                          <tr key={record.rowId ?? `${record.Date}-${record['Customer Name']}-${rowIndex}`}>
                            {tableHeaders.map((header) => (
                              <td key={header}>
                                {header === 'Verification' ? (
                                  <select
                                    aria-label={`History verification for ${record['Customer Name'] || `row ${rowIndex + 1}`}`}
                                    className={`verification-select ${getVerificationClass(record[header])}`}
                                    value={record[header] || ''}
                                    onChange={(event) => handleHistoryVerificationChange(rowIndex, event.target.value)}
                                  >
                                    <option value="">Pending</option>
                                    <option value="Yes">Yes</option>
                                    <option value="No">No</option>
                                  </select>
                                ) : header === 'Dharma Orders' ? (
                                  <select
                                    aria-label={`History Dharma Orders for ${record['Customer Name'] || `row ${rowIndex + 1}`}`}
                                    className={`verification-select ${getManualSelectClass(record[header])}`}
                                    value={record[header] || ''}
                                    onChange={(event) => handleHistoryDharmaOrdersChange(rowIndex, event.target.value)}
                                  >
                                    <option value="">-</option>
                                    <option value="Yes">Yes</option>
                                    <option value="No">No</option>
                                  </select>
                                ) : (
                                  record[header] || '-'
                                )}
                              </td>
                            ))}
                          </tr>
                        ))
                      ) : (
                        <tr className="empty-row">
                          <td colSpan={tableHeaders.length}>
                            {isHistoryLoading ? 'Loading payment history...' : 'No payment history for selected date'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export default HomeDashboard

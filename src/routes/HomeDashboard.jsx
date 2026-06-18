import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
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
]

const uploadHeaders = tableHeaders.filter((header) => header !== 'Verification')

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

      const hasDashboardValue = uploadHeaders.some((header) => record[header])

      return hasDashboardValue ? [...records, record] : records
    }, [])
  })
}

function HomeDashboard() {
  const [records, setRecords] = useState([])
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadedFileName, setUploadedFileName] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)

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

  const handleFileUpload = async (event) => {
    const [file] = event.target.files

    if (!file) {
      return
    }

    setUploadMessage(`Reading ${file.name}...`)
    setUploadedFileName('')
    setIsVerifying(false)

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

      setUploadMessage(
        `Loaded ${nextRecords.length} row${nextRecords.length === 1 ? '' : 's'} from ${file.name}.`,
      )
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
    setUploadMessage(`Verifying ${records.length} row${records.length === 1 ? '' : 's'} in Stripe...`)

    try {
      const recordsToVerify = records.map((record) => ({
        ...record,
        Verification: '',
      }))
      const verificationRows = await verifyStripePayments(recordsToVerify)
      const verifiedRecords = recordsToVerify.map((record, index) => ({
        ...record,
        Verification: verificationRows[index]?.verification === 'Yes' ? 'Yes' : 'No',
      }))

      setRecords(verifiedRecords)
      setUploadMessage(
        `Stripe verification complete for ${verifiedRecords.length} row${verifiedRecords.length === 1 ? '' : 's'}${uploadedFileName ? ` from ${uploadedFileName}` : ''}.`,
      )
    } catch (error) {
      setUploadMessage(error.message || 'Stripe verification failed. Please check the Stripe key and try again.')
      console.error(error)
    } finally {
      setIsVerifying(false)
    }
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
                          <span className={`verification-status ${getVerificationClass(record[header])}`}>
                            {record[header] || 'Pending'}
                          </span>
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
    </section>
  )
}

export default HomeDashboard

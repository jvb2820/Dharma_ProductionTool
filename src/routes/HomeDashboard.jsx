import { useState } from 'react'
import * as XLSX from 'xlsx'

const tableHeaders = [
  'Date',
  'Total Collected',
  'Tender Note',
  'Staff Name',
  'Description',
  'Customer Name',
  'Discount Name',
]

const normalizeHeader = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const normalizedHeaders = tableHeaders.map((header) => normalizeHeader(header))

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

      return normalizedHeaders.filter((header) => rowHeaders.includes(header)).length >= 2
    })

    if (headerRowIndex === -1) {
      return []
    }

    const headerRow = rows[headerRowIndex].map((cell) => normalizeHeader(cell))
    const columnIndexes = normalizedHeaders.map((header) => headerRow.indexOf(header))

    return rows.slice(headerRowIndex + 1).reduce((records, row) => {
      const record = tableHeaders.reduce((currentRecord, header, index) => {
        const columnIndex = columnIndexes[index]
        currentRecord[header] = columnIndex === -1 ? '' : String(row[columnIndex] ?? '').trim()
        return currentRecord
      }, {})

      const hasDashboardValue = tableHeaders.some((header) => record[header])

      return hasDashboardValue ? [...records, record] : records
    }, [])
  })
}

function HomeDashboard() {
  const [records, setRecords] = useState([])
  const [uploadMessage, setUploadMessage] = useState('')

  const handleFileUpload = async (event) => {
    const [file] = event.target.files

    if (!file) {
      return
    }

    setUploadMessage(`Reading ${file.name}...`)

    try {
      const fileBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(fileBuffer, { type: 'array', cellDates: true })
      const nextRecords = getRowsFromWorkbook(workbook)

      setRecords(nextRecords)
      setUploadMessage(
        nextRecords.length
          ? `Loaded ${nextRecords.length} row${nextRecords.length === 1 ? '' : 's'} from ${file.name}.`
          : `No matching dashboard headers were found in ${file.name}.`,
      )
    } catch (error) {
      setRecords([])
      setUploadMessage('Could not read that file. Please upload a valid CSV, XLS, or XLSX file.')
      console.error(error)
    }
  }

  return (
    <section className="route-view" aria-label="Home dashboard">
      <div className="upload-panel">
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
        {uploadMessage ? <p className="upload-message">{uploadMessage}</p> : null}
      </div>

      <div className="table-panel">
        <div className="table-shell">
          <table className="client-table">
            <thead>
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
                      <td key={header}>{record[header]}</td>
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

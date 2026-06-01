const tableHeaders = [
  'Phone Number',
  'Client Name',
  'Language',
  'Treatment',
  'Purchase Date',
  'Medical Form',
  'Prescribed?',
]

function HomeDashboard() {
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
        <input id="client-file-upload" type="file" accept=".csv,.xls,.xlsx" />
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
              <tr className="empty-row">
                <td colSpan={tableHeaders.length}>No records yet</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

export default HomeDashboard

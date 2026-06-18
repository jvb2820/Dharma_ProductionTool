const defaultPaymentHistoryUrl = 'http://127.0.0.1:3001/api/payment-history'

function getPaymentHistoryEndpoint() {
  return import.meta.env.VITE_PAYMENT_HISTORY_URL ?? defaultPaymentHistoryUrl
}

async function readPaymentHistoryResponse(response, fallbackMessage) {
  if (!response.ok) {
    let errorMessage = `${fallbackMessage}: ${response.status}`

    try {
      const payload = await response.json()
      if (payload?.message) {
        errorMessage = `${errorMessage} - ${payload.message}`
      }
    } catch {
      // Keep the status-only message if the API did not return JSON.
    }

    throw new Error(errorMessage)
  }

  const payload = await response.json()

  return Array.isArray(payload.rows) ? payload.rows : []
}

export async function loadPaymentHistory() {
  const response = await fetch(getPaymentHistoryEndpoint(), {
    cache: 'no-store',
  })

  return readPaymentHistoryResponse(response, 'Payment history request failed')
}

export async function savePaymentHistory(rows) {
  const response = await fetch(getPaymentHistoryEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows }),
  })

  return readPaymentHistoryResponse(response, 'Payment history save failed')
}

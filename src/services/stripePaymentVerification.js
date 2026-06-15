const defaultStripeVerificationUrl = 'http://127.0.0.1:3001/api/stripe/verify-payments'

export async function verifyStripePayments(rows) {
  const endpoint = import.meta.env.VITE_STRIPE_PAYMENT_VERIFICATION_URL ?? defaultStripeVerificationUrl
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows }),
  })

  if (!response.ok) {
    let errorMessage = `Stripe verification failed: ${response.status}`

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

  return Array.isArray(payload.rows) ? payload.rows : []
}

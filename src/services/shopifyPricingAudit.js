const defaultShopifyPricingAuditUrl = 'http://127.0.0.1:3001/api/pricing-audit'

function getShopifyPricingAuditUrl() {
  if (import.meta.env.VITE_SHOPIFY_PRICING_AUDIT_URL) {
    return import.meta.env.VITE_SHOPIFY_PRICING_AUDIT_URL
  }

  if (import.meta.env.VITE_SHOPIFY_TRACKING_URL) {
    return new URL('/api/pricing-audit', import.meta.env.VITE_SHOPIFY_TRACKING_URL).toString()
  }

  return defaultShopifyPricingAuditUrl
}

export async function auditShopifyPricing(rows) {
  const endpoint = getShopifyPricingAuditUrl()
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows }),
  })

  if (!response.ok) {
    let errorMessage = `Product pricing audit failed: ${response.status}`

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

  return {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    updatedAt: payload.updatedAt ?? null,
  }
}

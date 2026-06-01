# Production Tool

Vite React frontend with a small Node API that builds the HubSpot call report.

## Local Development

Create `.env.local` from `.env.example`, then set your real HubSpot private app token.

Run the API and frontend in separate terminals:

```sh
npm run api
npm run dev
```

## Deployment

Deploy the frontend to Vercel and the backend API to Render.

### Backend: Render Web Service

Use these settings:

```txt
Build command: npm ci
Start command: npm run api
Health check path: /health
```

Set these Render environment variables:

```txt
HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-your-real-token
HUBSPOT_API_ALLOWED_ORIGINS=https://your-vercel-app.vercel.app
HUBSPOT_REPORT_TIMEZONE=America/New_York
HUBSPOT_REPORT_DAY=today
```

After Render deploys, the API endpoint will be:

```txt
https://your-render-service.onrender.com/api/hubspot/call-report
```

### Frontend: Vercel

Use these settings:

```txt
Framework preset: Vite
Build command: npm run build
Output directory: dist
```

Set this Vercel environment variable before building:

```txt
VITE_HUBSPOT_CALL_REPORT_URL=https://your-render-service.onrender.com/api/hubspot/call-report
```

The HubSpot token must only be set on Render. Do not add `HUBSPOT_PRIVATE_APP_TOKEN` to Vercel.

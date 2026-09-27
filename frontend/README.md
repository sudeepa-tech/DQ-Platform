# Frontend — Veridata Dashboard

React (Vite) single-page app for the Enterprise Data Quality & Master Data
Intelligence Platform. Talks to the backend API (see `../backend`).

## Setup

```bash
npm install
cp .env.example .env   # set VITE_API_BASE_URL if the backend isn't on localhost:4000
npm run dev            # http://localhost:5173
```

## Build for production

```bash
npm run build           # outputs static assets to dist/
```

Serve `dist/` with any static file server (nginx, Caddy, a CDN, etc.) behind
the same origin or a CORS-permitted origin relative to the backend API.

## Structure

- `src/api/client.js` — thin fetch wrapper, JWT attached from localStorage
- `src/context/AuthContext.jsx` — auth state
- `src/components/` — Sidebar (with Phase 2 locked-module nav), badges,
  health gauge, processing-stage tracker, modal, empty/loading/error states
- `src/pages/` — Login, dataset list/create, dataset detail (upload + sheet
  selection + run history), run dashboard (Overview / Issue Explorer /
  Duplicate & Entity Intelligence / Conflicts / Export tabs), record detail

## Design system

See `src/styles/tokens.css` for the color/type/spacing tokens and
`src/styles/global.css` for the component classes. The visual direction is a
graphite instrument-panel aesthetic (not the generic warm-cream or
neon-dark-mode SaaS defaults) with severity colors as the only saturated
hues carrying real meaning.

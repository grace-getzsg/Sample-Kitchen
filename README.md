# Kitchen Planner

The app uses a static page and Vercel Node.js functions. Operational sample files remain local and are not bundled into the app.

## Run locally

With Node.js installed, copy `.env.example` to `.env`, add a Postgres `DATABASE_URL` and a long random `OWNER_IMPORT_TOKEN`, then install dependencies and start the local server:

```text
npm install
npm start
```

Then open `http://localhost:3000`. The health endpoint is `http://localhost:3000/api/health`.

## Initial database setup

`database/schema.sql` defines the PostgreSQL tables. The API initializes this schema when it first connects. The three build-time reference documents are in `reference-data/`: scenario, products and recipes, and supplier. Imports are owner-gated by `OWNER_IMPORT_TOKEN`; Postgres access stays in server-side code.

## Vercel

Deploy this folder as a project using Vercel's default static hosting and Node.js functions. Add `DATABASE_URL` and `OWNER_IMPORT_TOKEN` as server-side environment variables. The page is in `public/`; `/api/health` and `/api/imports` are implemented as functions.

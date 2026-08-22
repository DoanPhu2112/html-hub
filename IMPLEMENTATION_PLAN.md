# HTML Hub Implementation Plan

## Target architecture

- Single Docker app on the Pop!_OS host.
- Same-origin SPA and API to avoid CORS.
- Public access through Cloudflare Tunnel to `http://localhost:4173`.
- SPA routes and static assets served by the app.
- JSON API under `/api/*`.
- SQLite persisted at `./data/html-hub.sqlite`.
- Uploaded files persisted under `./uploads/`.
- Categories managed by code in `categories.json`.

## Implemented v0 scope

- [x] SPA front page with categories-first layout.
- [x] Name-only login; no password.
- [x] User name stored in SQLite through `/api/users/name`.
- [x] Upload form with manual category selection.
- [x] Upload metadata stored in SQLite.
- [x] Uploaded files stored on host disk.
- [x] Slide list loaded from `/api/slides`.
- [x] Category list loaded from `/api/categories`.
- [x] Dockerfile and Docker Compose setup.

## API contract

- `GET /api/health`
  - Returns app health.

- `GET /api/categories`
  - Returns active code-managed categories and slide counts.

- `GET /api/slides`
  - Returns uploaded slide metadata.

- `POST /api/users/name`
  - Body: `{ "name": "Phu" }`
  - Creates or reuses a user row.

- `POST /api/slides`
  - Multipart form fields:
    - `categoryId`
    - `title`
    - `tags`
    - `userId`
    - `file`
  - Saves file to `uploads/` and metadata to SQLite.

## Current constraints

- PPT/PPTX files are stored and shared, not converted to web slides.
- ZIP files are stored as archives, not unpacked yet.
- No password or access restriction.
- No upload token in current no-restriction phase.
- No background thumbnail generation.

## Next useful experiments

- Add ZIP extraction for HTML decks with `index.html` preview.
- Add delete/rename slide operations.
- Add upload size display and progress bar.
- Add Cloudflare Tunnel service file for the host.
- Add nightly backup script for `data/` and `uploads/`.

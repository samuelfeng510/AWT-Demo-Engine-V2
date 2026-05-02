# AWT Demo Engine

Web app (Google Apps Script) that plans synthetic BigQuery demos, optional Google Workspace seed data, and a downloadable `setup.sh` that provisions an ADK agent with BigQuery and Maps MCP toolsets.

**Public repository:** [github.com/samuelfeng510/AWT-Demo-Engine-V2](https://github.com/samuelfeng510/AWT-Demo-Engine-V2)

## What belongs in Git vs deployment

This repo intentionally holds **no secrets**. Configure these only in the Apps Script project (**Project Settings → Script properties**), not in source files:

| Property | Purpose |
|----------|---------|
| `PROJECT_ID` | GCP project for Vertex AI calls |
| `LOG_SHEET_URL` | Spreadsheet for telemetry (optional but expected by the app) |
| `VERTEX_SERVICE_ACCOUNT_JSON` | Service account JSON **as a single-line string** for Vertex (never commit the JSON file) |
| `MODEL` | Optional override for the Vertex model id |

User-created OAuth client IDs, Maps API keys, Gmail secrets, and Secret Manager payloads are created **at runtime** in the user’s project when they run `setup.sh`—they are not stored in this repository.

## Layout

- `Code.gs` — Backend: planning, validation, Drive demo kit, `setup.sh` generation  
- `index.html` — Web UI  
- `appsscript.json` — Apps Script manifest (scopes only; no secrets)  
- `SetupError.html` — Setup error template  

Upstream inspiration: [GE Demo Generator](https://github.com/ryotat7/ge-demo-generator) (Ryota Tokodai).

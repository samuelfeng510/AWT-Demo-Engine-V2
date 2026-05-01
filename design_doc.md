# Demo Generator: Enterprise Workflow Orchestration Upgrade
# AI Developer PRD & Architecture Guide

## 1. Project Context
- **Current State:** A Google Apps Script (GAS) application (`Code.gs`, `index.html`) that uses Vertex AI to generate synthetic BigQuery data, a custom Agent persona, and a bash deployment script (`setup.sh`). It currently focuses on single-agent, data-analysis interactions.
- **Target State:** Upgrade the generator to create "Enterprise Workflow Orchestration" demos. The generated bash script must not only provision BigQuery data but also pre-populate Google Workspace services (e.g., injecting seed emails into Gmail, generating Google Docs) to create realistic, multi-service demo environments.
- **Future-proofing:** The architecture must remain tool-agnostic. Keep Workspace API logic encapsulated within the deployment script and Python tool files so it can easily be swapped with Google Workspace MCP (Model Context Protocol) servers in the future without altering the core generation logic.

## 2. Core Concepts (Abstraction)
Instead of letting users manually combine underlying APIs (which leads to broken or illogical demos), we abstract the complexity into two user-facing dimensions:

### Dimension A: Demo Length (T-Shirt Sizing)
1. **Short (5-10 mins):** Focuses on single-point efficiency and quick agent responses.
2. **Medium (15-20 mins):** Focuses on cross-system data insights and reporting.
3. **Long (30+ mins):** Focuses on End-to-End complex business orchestration.

### Dimension B: Workflow Archetypes
1. **Triage & Response:**
   - *Context:* Customer service, IT ticketing, Lead processing.
   - *Workspace Integration:* Pre-populate Gmail with a customer inquiry -> Agent analyzes BQ -> Agent drafts a Doc or replies via Gmail.
2. **Data to Insight:**
   - *Context:* Financial analysis, Marketing ROI, Operations auditing.
   - *Workspace Integration:* Agent analyzes BQ anomalies -> Automatically generates a Google Slides executive summary or Sheets report.
3. **Complex Orchestration:**
   - *Context:* Supply chain crisis, Cross-department project kickoff.
   - *Workspace Integration:* Pre-populate Gmail (Crisis alert) -> Agent analyzes BQ -> Agent creates a Google Sheet (Impact list) -> Agent sends Google Chat notification.

## 3. Data Structure Changes
The LLM prompt in `Code.gs` (`buildPlanningPrompt`) must be updated to output additional JSON structures:
1. **`workspaceSeedData`:** Instructions for the deployment script to pre-populate data before the demo starts.
   - *Example:* `{"emailsToInject": [{"subject": "...", "body": "...", "from": "..."}]}`
2. **`demoGuide` Enhancement:** Must be a rich Markdown structure detailing the step-by-step demo script (What to click, what to say, what to expect), which will later be compiled into a Google Doc.

## 4. Implementation Phasing
*AI Assistant: Please implement this strictly phase by phase. Do not jump ahead to future phases.*

- **Phase 1: UI Modification (`index.html`)**
  - Update the Step 1 form to include the new Dimensions (Demo Length & Workflow Archetype). Ensure data binds correctly to the payload sent to the GAS backend.
- **Phase 2: LLM Prompt Engine Upgrade (`Code.gs`)**
  - Update `buildPlanningPrompt` to process the new dimensions. Instruct the LLM to generate `workspaceSeedData` and the enhanced `demoGuide` Markdown. Update the JSON schema expectations.
- **Phase 3: Hybrid Deployment Script (`setup.sh` generation)**
  - Modify `generateSetupScript` in `Code.gs`. Inject logic/scripts into the `setup.sh` to call Workspace APIs (e.g., using `curl` or Python snippets for Gmail `Users.messages.insert`) to provision the `workspaceSeedData` at deployment time.
- **Phase 4: Docs Generation**
  - Add logic in `generateDemo` (`Code.gs`) to convert the Markdown `demoGuide` into a Google Doc via `DocumentApp` and return the public URL to the user in the UI and the terminal.
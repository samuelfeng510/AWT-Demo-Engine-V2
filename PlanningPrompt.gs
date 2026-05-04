/**
 * Planning prompt builder and output-language helpers (demo guide / assets / prompts).
 */

/** Display labels for generator UI output languages (BCP-47 style codes). */
var SUPPORTED_OUTPUT_LANGUAGES = {
  'en': { englishLabel: 'English', nativeLabel: 'English' },
  'ja': { englishLabel: 'Japanese', nativeLabel: '日本語' },
  'zh-TW': { englishLabel: 'Traditional Chinese', nativeLabel: '繁體中文' },
  'ko': { englishLabel: 'Korean', nativeLabel: '한국어' },
  'id': { englishLabel: 'Indonesian (Bahasa Indonesia)', nativeLabel: 'Bahasa Indonesia' },
  'fil': { englishLabel: 'Filipino', nativeLabel: 'Filipino' },
  'th': { englishLabel: 'Thai', nativeLabel: 'ไทย' },
  'vi': { englishLabel: 'Vietnamese', nativeLabel: 'Tiếng Việt' }
};

/**
 * @param {string} [raw]
 * @returns {'auto'|'en'|'ja'|'zh-TW'|'ko'|'id'|'fil'|'th'|'vi'}
 */
function normalizeOutputLanguageCode_(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'auto';
  var s = String(raw).trim();
  if (/^auto$/i.test(s)) return 'auto';
  if (s === 'zh-TW' || s.toLowerCase() === 'zh-tw') return 'zh-TW';
  var lower = s.toLowerCase();
  if (lower === 'en') return 'en';
  if (lower === 'ja') return 'ja';
  if (lower === 'ko') return 'ko';
  if (lower === 'id') return 'id';
  if (lower === 'fil') return 'fil';
  if (lower === 'th') return 'th';
  if (lower === 'vi') return 'vi';
  return 'auto';
}

function getOutputLanguageSpec_(code) {
  if (code === 'auto') {
    return { englishLabel: 'Auto (infer from business problem)', nativeLabel: 'Auto' };
  }
  var spec = SUPPORTED_OUTPUT_LANGUAGES[code];
  return spec || SUPPORTED_OUTPUT_LANGUAGES['en'];
}

function buildOutputLanguageInstructionBlock_(code, spec) {
  if (code === 'auto') return '';
  return (
    '\n## OUTPUT LANGUAGE (MANDATORY — USER SELECTED)\n' +
    'The generator UI requested **all narrator-facing demo collateral** in **' +
    spec.nativeLabel +
    '** (' +
    spec.englishLabel +
    '; code: `' +
    code +
    '`).\n\n' +
    'Apply to **demoGuide**, **scenarioPrompts**, **externalFiles** (`description`, PDF/Excel `fileContent`), **workspaceSeedData** free-text, **systemInstruction**, **appliedFactors**, **oneSentenceSummary**, table/column **description** fields, and STRING values in CSV. Google product names (e.g. Gmail) may stay conventional.\n\n' +
    '**Self-check:** User-facing text must be **' +
    spec.nativeLabel +
    '**, not English, except technical identifiers (English snake_case).\n\n'
  );
}

function buildLanguageConsistencyRules_(code, spec) {
  var bulletList =
    '    - Table and Column descriptions\n' +
    '    - STRING values in the CSV data (e.g., product names, categories, person names, names of things)\n' +
    '    - systemInstruction\n' +
    '    - appliedFactors descriptions\n' +
    '    - scenarioPrompts titles and prompts (one per **## Scene**, aligned to **The Prompt:**)\n' +
    '    - demoGuide Markdown (all narrator-facing script text, **Steps / The Narrative / The Prompt** per scene)\n' +
    '    - workspaceSeedData free-text fields (emails bodies, chat text, synopsis bullets, summaries)\n' +
    '    - externalFiles fileName and fileContent';
  if (code === 'auto') {
    return (
      '- **LANGUAGE CONSISTENCY (CRITICAL)**: Detect the language used in the "Business Problem" above. You MUST use this same language for ALL user-facing fields, including:\n' +
      bulletList
    );
  }
  return (
    '- **LANGUAGE CONSISTENCY (CRITICAL)**: **Output language (UI): ' +
      spec.nativeLabel +
      '** (`' +
      code +
      '`). The user explicitly selected this language. Use it for ALL user-facing fields (even if the Business Problem is written in another language), including:\n' +
      bulletList
  );
}

function buildWorkspaceSeedLanguageLine_(code, spec) {
  if (code === 'auto') {
    return 'Ensure content **languages** match the business problem language.';
  }
  return 'Ensure content **languages** use the **selected output language (' + spec.nativeLabel + ')** for all narrator-facing seed text.';
}

function buildChartTranslationClause_(code, spec) {
  if (code === 'auto') {
    return (
      'When including data chart placeholders \'[CHART: Title, ... ]\', you **MUST translate the Title and Metric Labels into the language of the business problem** ' +
      '(e.g., if the problem is in Japanese, translate \'Metrics\' to Japanese).'
    );
  }
  return (
    'When including data chart placeholders \'[CHART: Title, ... ]\', you **MUST translate the Title and Metric Labels into ' +
      spec.nativeLabel +
      '** (the selected output language).'
  );
}

function buildPlanningPrompt(userGoal, options) {
  const maxRows = Math.min(options.rowCount || 100, 150);
  const publicDatasetInfo = options.usePublicDataset && options.publicDatasetId 
    ? `- RELATED PUBLIC DATASET (ENRICHMENT ONLY): ${options.publicDatasetId}
       * ROLE: This dataset serves as EXTERNAL CONTEXT (e.g., weather, statistics) to enrich the core business data.
       * CONSTRAINT: DO NOT use this dataset as a replacement for core business operations (e.g., do not use public orders/customers if you are generating a retail demo).
       * JOIN STRATEGY: Link via common attributes like 'zip_code', 'category', 'region', or 'date' rather than internal system IDs.`
    : `- IMPORTANT: NO public dataset should be used for this demo. Focus ONLY on synthetic tables below. Do NOT attempt to JOIN with external public-data.`;

  const demoLengthKey = String(options.demoLength || 'medium').toLowerCase();
  const workflowArchetypeKey = String(options.workflowArchetype || 'triage_response').toLowerCase();

  const outputLangCode = normalizeOutputLanguageCode_(options && options.outputLanguage);
  const outputLangSpec = getOutputLanguageSpec_(outputLangCode);
  const outputLanguagePreamble = buildOutputLanguageInstructionBlock_(outputLangCode, outputLangSpec);
  const languageConsistencyRules = buildLanguageConsistencyRules_(outputLangCode, outputLangSpec);
  const workspaceSeedLanguageLine = buildWorkspaceSeedLanguageLine_(outputLangCode, outputLangSpec);
  const chartTranslationClause = buildChartTranslationClause_(outputLangCode, outputLangSpec);

  const demoLengthGuide = ({
    short: 'Short (~5-10 minutes): Prefer a narrower scope, fewer seeded Workspace artifacts, and a quicker resolution arc while still respecting all table/external-file rules below.',
    medium: 'Medium (~15-20 minutes): Balanced depth — cross-system insights, moderate pacing, several presenter beats.',
    long: 'Long (30+ minutes): Full storyline — richer workspaceSeedData, more presenter steps, and end-to-end cadence.'
  })[demoLengthKey] || `Calibrate pacing and richness to demo length "${demoLengthKey}".`;

  const archetypeGuide = ({
    triage_response: 'Triage & Response: Emphasize inbound issue handling (e.g., customer inquiries, tickets, leads). Seed materials should foreshadow classify → investigate in data → propose reply or drafted artifact.',
    data_to_insight: 'Data to Insight: Emphasize analytical progression from anomalies in warehouse data → exec-ready narrative (e.g., Slides-ready storyline, metric callouts referencing your synthetic tables only).',
    complex_orchestration: 'Complex Orchestration: Emphasize multi-step operational flows (alert → analysis → workbook or doc synthesis → escalation / stakeholder ping). Seeds should cue several dependent actions across channels.'
  })[workflowArchetypeKey] || `Shape the storyline to workflow archetype "${workflowArchetypeKey}".`;

  const workflowRoutingBlock = `
## DYNAMIC WORKFLOW ROUTING (MANDATORY)

You MUST dynamically structure the **demoGuide** Markdown based on the following parameters:

**Length:** "${demoLengthKey}" — Short = **1–2** scenes (each scene is one \`## Scene ...\` section). Medium = **3–4** scenes. Long = **5+** scenes.

**Archetype:** "${workflowArchetypeKey}".

Apply the product flow that matches the archetype (use these rules strictly):

- If **triage_response** (Triage & Response): the demo MUST **start in Gmail** (AI Inbox), **move to Google Docs** (Help me write), and **use Google Chat**. Scene order and titles MUST reflect this sequence.

- If **data_to_insight** (Data to Insight): the demo MUST **start in BigQuery / Gemini Enterprise**, **move to Google Sheets** (Gemini side panel / Canvas), and **end in Google Slides** (Help me visualize / side panel).

- If **complex_orchestration** (Complex Orchestration): the demo MUST span **Gmail**, **Gemini Enterprise**, **Sheets**, **Slides**, and **conclude with Google Workspace Studio** (building an Agentic AI workflow).

The scene count MUST match the Length band above. Do **not** substitute a fixed number of copy-paste prompts for scene design — scenes drive the story.
`;

  const orchestrationBlock = `
## Demo orchestration profile (respect alongside ALL BigQuery constraints below)
- **Selected demo length (UI)**: "${demoLengthKey}" — ${demoLengthGuide}
- **Selected workflow archetype (UI)**: "${workflowArchetypeKey}" — ${archetypeGuide}

${workflowRoutingBlock}

**SCENARIO ADAPTATION (REQUIRED)**:
1. Interpret and **re-frame the BUSINESS PROBLEM** so the operative demo narrative clearly reflects the archetype (${workflowArchetypeKey}) and the workflow routing above, without contradicting facts the user supplied.
2. Keep **CSV schemas, relational rules, anomalies, PDF/Excel requirements, row targets, joins, naming, language rules** exactly as mandated in sections below — only adapt *story-facing* fields (instructions, summaries, seeded text content, anomaly *labels/context* where logical).
3. **Scale** the "workspaceSeedData" object and the **detail level** of the Markdown **demoGuide** to demo length (${demoLengthKey}): short = fewer scenes and leaner copy; long = more scenes and fuller narration.
4. "workspaceSeedData" is for eventual deployment-time injection (conceptual Gmail/Chat/Docs payloads). Align seeds with BOTH the archetype and the synthetic IDs/facts already present or implied in "tables" / "externalFiles"; do not invent contradictory transaction keys.

## Workspace seeding & Markdown demo guide (additive)
Produce **workspaceSeedData** and **demoGuide** in addition to all existing outputs. Treat these as narrator-facing collateral; warehouse generation rules remain authoritative.

### workspaceSeedData
Return a SINGLE JSON object (see schema in output example) capturing **realistic exemplar payloads** suited to Workspace-style prep (to be scripted later outside this step). Populate only what fits the scenario; omit empty arrays. Examples of useful keys (all optional unless you need them for the archetype):

- "sampleEmails" / "emailsToInject": subject, plaintext or Markdown-style body (escape newlines appropriately for JSON), from, to, synthetic thread identifiers tied to seeded anomalies.
- "chatThreads" / "chatScenarios": ordered messages with speaker role and text for Google Chat-like replay.
- "calendarHooks": optional briefing titles/time hints (text only).
- "docSynopsis" / "sheetSynopsis": bullet outlines referencing **which tables** the demo will hinge on (no hallucinated schemas beyond yours).
- "presentationBeats": optional bullets for eventual Slides script (titles + key figures to cite from data).
- "prepChecklist": strings presenter does before demo (GCP side — generic wording).

**SEED ↔ SCENE 1 (CRITICAL):** Generate seed data (e.g., a starting email for Gmail, starter Doc text, or initial Sheet context) that **matches Scene 1** of the demo guide so the deployment script can pre-populate the environment before the presenter begins.

${workspaceSeedLanguageLine} Keep payloads professional; avoid vague placeholders like "TODO".

### demoGuide (single comprehensive Markdown string)
Return **demoGuide** as **one** JSON string containing **full Markdown** (use \`\\n\` for newlines inside the JSON string).

The Markdown MUST include one section per scene using **exactly** this per-scene structure (repeat for Scene 1..N; **N** must match the Length / archetype routing rules above):

\`\`\`
## Scene X: [App Name] - [Action]

**Steps:** [What the user clicks]

**The Narrative:** [What the presenter says aloud]

**The Prompt:** [The exact text to type into Gemini / Workspace]
\`\`\`

You may add an optional short introduction paragraph **before** Scene 1. Within scenes, you may use bullet lists under **Steps** if helpful.

**FILENAME DISCLOSURE (NARRATOR ONLY):** When the script references attaching synthetic files, cite the exact \`externalFiles[].fileName\` in **Steps** or **The Narrative**. Do **NOT** put filenames or extensions inside **scenarioPrompts**.prompt text (keep generic: "the uploaded PDF", "the spreadsheet export").

### scenarioPrompts (aligned to scenes — not a fixed count)
Emit **scenarioPrompts** as a JSON array of objects \`{ "title", "prompt", "requiredFileId", "tags" }\`.

**COUNT & ORDER (CRITICAL):** The **scenarioPrompts** array MUST contain **exactly one object per \`## Scene\`** in **demoGuide**, in the **same order** (Scene 1 → first array element, etc.). The \`prompt\` field MUST mirror the **The Prompt:** text from that scene (same intent; obey the **NO FILENAMES** rule below). Titles should name the scene goal and persona when helpful.

`;
  
  return `You are a versatile data analyst and BigQuery expert capable of generating realistic datasets for ANY industry or business function.
Design and generate a demo dataset based on the following business problem.

**DOMAIN ADAPTATION**: Carefully analyze the business problem below to identify the industry, job function, and operational context. Adapt ALL data generation (table structures, column names, values, relationships) to match that specific domain. Do not default to generic examples or assume a particular industry unless explicitly stated.

- **🚀 THEME: Mundane but High Impact Operations Automation (including GTM/Sales/Marketing)**: 
    - **Focus**: Tedious, manual, friction-heavy tasks (often involving data reconciliation, auditing, or compliance checks) that occupy hours of human time but have high stakes (revenue recognition, compliance, SLA breaches, pipeline leakages).
    - **Examples**: 
        - **Operations**: Auditing invoices/quotes (PDF) against transactional databases (BigQuery) to find pricing anomalies.
        - **Logistics/Supply Chain**: Cross-referencing shipping logs (text) with inventory master data to resolve stock discrepancies or delay root-causes.
        - **Sales/Marketing (GTM)**: Identifying duplicates or scoring anomalies in lead data across silos (CRM vs Marketing Hub), discount override auditing, validating contracts against billings, segment overlap anomalies, RFP comparisons vs inventory capabilities.
    - **Constraint**: Avoid "surface-level high-level analytics" (e.g., "Analyze market trends and give a pie chart"). Instead, focus on "finding concrete inconsistencies, matching records across silos, and flagging rule violations (auditing)".

## Business Problem
${userGoal}
${outputLanguagePreamble}
${orchestrationBlock}

## Requirements
- Number of tables: ${options.tableCount}
- Table Design & Row Counts (Star Schema Strategy):
    - **Master/Dimension Tables** (e.g., products, facilities, users): Target **10-15 columns** (high depth with rich attributes) and **30-50 rows** (to manage token limits).
    - **Transaction/Log Tables** (e.g., sales, access logs, events): Target **4-6 columns** (lean) and target at least 80 rows (up to **${maxRows} rows**).
${publicDatasetInfo}

## REALISTIC DATA SYNTHESIS (CRITICAL)
Generate data that reflects real-world business complexity. Apply the following domain-agnostic principles, **adapting them to the specific industry/function identified above**:

### 1. Temporal Patterns
Apply cyclical variations appropriate to the business context:
- **Day-of-week effects**: Weekday vs. weekend behavioral differences
- **End-of-period spikes**: Month-end, quarter-end, or fiscal year-end concentrations
- **Holiday/Event impacts**: Peak periods, promotional windows, or seasonal patterns
Infer relevant cycles based on the stated industry and problem.

### 2. Attribute Correlations
Ensure realistic correlations between dimensions:
- **Geography × Behavior**: Regional preferences, local trends, or location-based patterns
- **Segment × Channel**: Customer type affecting preferred interaction methods
- **Tier/Rank × Frequency**: Engagement levels varying by loyalty status or classification
Create statistically plausible distributions — not random noise.

### 3. Business Logic Linkage (Cross-Table Consistency)
Ensure data across tables is logically consistent:
- **Constraint-based value linkage**: Capacity limits affecting downstream transactions (e.g., if a resource is exhausted, related activity stops)
- **Status/State transitions**: Multi-step workflows with valid state progressions
- **Temporal dependencies**: Lead times between related events (e.g., approval → execution timing)
Infer appropriate business rules based on the stated industry and challenge.

### 4. Real-World Content (CRITICAL - Avoid Fictional Data)
Use **actual real-world data** wherever possible to maximize authenticity:
- **Products/Brands**: Use real brand names, product lines, and SKUs appropriate to the industry (e.g., "iPhone 15 Pro", "Nike Air Max", "Toyota Camry")
- **Geographic Locations**: Use real city names, regions, and countries. Match locations to the business context (e.g., major retail markets, manufacturing hubs)
- **Person Names**: Use culturally appropriate, realistic names for the stated region/language (e.g., Japanese names for Japan-based scenarios)
- **Numerical Values**: Use realistic price points, quantities, and metrics based on real-world benchmarks (e.g., actual market prices, typical order volumes)
- **Dates**: Use recent, realistic dates anchored to the referenceDate. For \`DATE\` columns, use \`YYYY-MM-DD\`. For \`TIMESTAMP\` columns, use \`YYYY-MM-DD HH:MM:SS\` format. Do not use plain dates in timestamp columns.

**DO NOT invent fictional brands, fake product names, or placeholder values like "Product A" or "Company XYZ".**

### 5. Factual Consistency (CRITICAL - Company/Entity Alignment)
If the business problem mentions a **specific company, organization, or brand**, ensure ALL generated data is factually consistent with that entity:
- **Employees/Talents/Staff**: Only use names of people who ACTUALLY belong to that organization. Do NOT mix in people from competing organizations.
- **Products/Services**: Only use products/services that the specified company ACTUALLY offers. Do NOT include competitor products.
- **Locations/Facilities**: Only reference facilities that the company ACTUALLY owns or operates. Do NOT use generic placeholder names.
- **Partnerships/Clients**: Reference realistic business relationships based on publicly known information.

**If you are unsure whether a specific entity belongs to the mentioned company, DO NOT include it. It is better to use fewer but accurate data points than to include factually incorrect associations.**

**If NO specific company/organization is mentioned in the business problem**: Create a COHERENT fictional business context. Choose ONE realistic company profile (industry vertical, size, geography) and generate ALL data as if it belongs to this single hypothetical entity. Ensure internal consistency - all facilities, products, and personnel should belong to the same fictional organization. Do NOT mix data from multiple unrelated real-world companies.

### 6. Audit Seeds
Inject intentional discrepancies between data silos to enable "Detective/Auditing" demos:
- **Discrepancy**: A transaction ID or price in the external file (PDF/Excel) should *slightly* mismatch the record in BigQuery (e.g., Invoice says $120, BigQuery says $100).
- **Rule Violation**: Some records should violate business rules (e.g., discount applied without approval code).

### 7. Visual Seeds
Incorporate visual attributes into the database schema ONLY when relevant to the business domain and restricted to appropriate asset-focused tables:
- **Conditional Inclusion**: Only include descriptive visual attributes (e.g., colors, materials, styles) if the business problem involves industries where visual characteristics are key data points (e.g., Fashion, Retail, Product Marketing, Real Estate).
- **Table Restriction**: Restrict these attributes to dedicated tables such as "Product Catalog", "Asset Master", or "Menu Items". Do NOT include them in transactional or unrelated master tables (e.g., Customer Master, Order Details).
- **Analytical Context**: Rely primarily on the agent's system instructions to determine visual output styles (e.g., business slides, infographics) rather than forcing visual columns in the database schema.


## Output Format (JSON)
Output in the following JSON format. Output **pure JSON only without code blocks**.

{
  "externalFiles": [
    {
      "id": "file1",
      "fileName": "invoice_reconciliation_audit.pdf",
      "mimeType": "application/pdf",
      "fileContent": "# Invoice Audit Report\\n\\n## Summary\\nAudit of recent vendor invoices against procurement logs.\\n\\n## Found Discrepancies\\n- Invoice INV-7829: Unit price differs by 12% from system purchase order.\\n- Invoice INV-7830: Shipped quantity does not match received warehouse logs.\\n\\n## Rules to Apply\\n- Flag if discrepancy > 5%\\n- Escalate if total deviation > $1000",
      "description": "Description of the file and its usage context."
    },
    {
      "id": "file2",
      "fileName": "inventory_log_export.xlsx",
      "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "fileContent": "Date\\tProduct\\tQuantity\\tStatus\\n2023-11-01\\tProduct A\\t100\\tIn-Stock\\n2023-11-02\\tProduct B\\t50\\tLow-Stock",
      "description": "Complex semi-structured data log in TSV format."
    }
  ],
  "tables": [
    {
      "tableName": "Table name (English, snake_case)",
      "description": "Description of the table",
      "schema": [
        {"name": "column_name", "type": "STRING|INTEGER|FLOAT|DATE", "description": "Column description"}
      ],
      "csvData": "column1,column2,...\\nvalue1,value2,...\\n..."
    }
  ],
  "systemInstruction": "Specific instruction for the agent (3-5 sentences). 1. Define persona/expertise. 2. **EMPHASIZE WOW FACTORS**: Instruct the agent to perform **Cross-silo reasoning, Proactive investigation, and Actionable output generation** (e.g., drafting emails, SQL patches). 3. **VISUALIZATION**: Instruct the agent to use the 'generate_image' tool to create a visual representation of its findings and solutions when providing a final answer to the user's inquiry. **This visual MUST be in the style of a professional business document or slide (e.g., an Executive Summary card, a high-level business infographic, or a stylized data summary document) that summarizes the insights. The agent MUST use the following style elements by default: 'Professional business presentation slide', 'Clean layout', 'Structured design', 'Executive summary at the top', 'Data visualization', 'Infographic charts', 'Bullet points', 'Flowchart', 'Corporate blue and gray palette', 'Minimalist color scheme', 'High resolution', 'Crisp text placeholders', and 'Modern typography'. The agent MUST NOT include any mention of specific names of consulting firms or the phrase 'consulting firm' in the prompt for the image unless the user explicitly specifies it. The agent MUST NOT generate simple photos or renders of the products themselves.** **CRITICAL**: The agent MUST ONLY generate these visuals for actual result outputs that answer the inquiry, and NOT for follow-up questions, clarifications, or intermediate responses. **ANTI-HALLUCINATION (CRITICAL)**: The prompt for the generated image MUST ONLY contain factual data, metrics, and insights derived directly from the analyzed data. It MUST NOT contain any hallucinated information, fabricated numbers, or speculative content. 4. Instruct to wait for user input before acting, but be persistent in error recovery. 5. **TRANSPARENCY & GROUNDING (CRITICAL)**: Instruct the agent to be highly transparent about its reasoning, explicitly mentioning which tables and files it is consulting and what specific values it found, to ensure the user can trace its logic back to the source data and avoid the perception of hallucination.",
  "referenceDate": "YYYY-MM-DD",
  "publicDatasetId": "bigquery-public-data.dataset.table",
  "oneSentenceSummary": "A concise, professional one-sentence summary of the business challenge and the generated solution.",
  "appliedFactors": {
    "temporalPatterns": ["List of 2-3 specific temporal patterns applied (e.g., 'Weekday lunch surge', 'Month-end reconciliation spike')"],
    "correlations": ["List of 2-3 specific data correlations applied (e.g., 'Region-specific product preference', 'High-tier customer loyalty frequency')"],
    "businessLogic": ["List of 2-3 specific business logic constraints applied (e.g., 'Inventory threshold triggers', 'Sequential status transition integrity')"]
  },
  "workspaceSeedData": {
    "archetypeEcho": "${workflowArchetypeKey}",
    "demoLengthEcho": "${demoLengthKey}",
    "summary": "1-3 sentences aligning seeds with seeded anomalies/archetype",
    "emailsToInject": [
      {"threadIdHint": "triage-001", "from": "person@example.com", "to": "agent-inbox@example.com", "subject": "Synthetic issue tied to seeded anomaly", "bodyPlain": "Detailed email referencing IDs that exist in CSV/PDF artefacts", "intent": "triage_followup"}
    ],
    "chatScenarios": [
      {"topic": "Ops bridge", "messages": [{"role": "user", "text": "Ping referencing anomaly IDs echoed in warehouse tables"}]}
    ],
    "docSynopsis": ["Bullets outlining Doc narrative tied to anomalies"],
    "sheetSynopsis": ["Metrics presenters should cite from BigQuery reasoning"],
    "prepChecklist": ["Verify dataset loaded", "Prepare agent pane", "Have external files handy"]
  },
  "demoGuide": "# Demo Flow\\n\\n## Scene 1: Gmail - Triage\\n\\n**Steps:** Open Gmail → …\\n\\n**The Narrative:** …\\n\\n**The Prompt:** …\\n\\n## Scene 2: Google Docs - Draft\\n\\n**Steps:** …\\n\\n**The Narrative:** …\\n\\n**The Prompt:** …",
  "scenarioPrompts": [
    {
      "title": "Scene 1 — title aligned to demoGuide Scene 1",
      "prompt": "... mirrors **The Prompt:** from Scene 1; no filenames; generic file references only ...",
      "requiredFileId": "",
      "tags": ["Scene1"]
    },
    {
      "title": "Scene 2 — title aligned to demoGuide Scene 2",
      "prompt": "... mirrors **The Prompt:** from Scene 2 ...",
      "requiredFileId": "",
      "tags": ["Scene2"]
    }
  ]
}

**IMPORTANT — demoGuide + scenarioPrompts**:
- **demoGuide** MUST be a **single Markdown string** (as shown). Do **not** return an array of objects for **demoGuide**.
- **scenarioPrompts** MUST contain **one object per \`## Scene\`** in **demoGuide** (same order and count). Do **not** pad to a fixed number of prompts.

## Critical Notes
- **SCENARIO PROMPTS & DEMO GUIDE (CRITICAL)**: **scenarioPrompts** MUST mirror **demoGuide**: **same number of entries as \`## Scene\` sections**, same order. Each \`prompt\` MUST align with that scene's **The Prompt:** (generic file wording only — see NO FILENAMES). Showcase reasoning and tool-use across the **whole demo**, distributed across scenes (not a rigid "five prompt" template).
    - **NO FILENAMES (CRITICAL)**: DO NOT include specific file names or extensions (e.g., 'market_report_2024', 'data.tsv') in \`scenarioPrompts[].prompt\`. Use generic phrasing.
    1. **PROGRESSION (CRITICAL)**: Build a **logical arc** across scenes matching the selected **Archetype** and **Length** (e.g., early scenes: multi-table correlation; mid scenes: audit / root-cause with the spreadsheet export; include unstructured PDF cross-check; include geospatial reasoning where the business problem supports it; closing scenes: executive / what-if synthesis). Assign **requiredFileId** to reference \`externalFiles[].id\` only for scenes that actually use that file in **The Prompt:**.
    2. **PERSONA ROTATION (CRITICAL)**: Vary the tone and perspective across scenes (e.g., CFO, Ops Manager, Regional Director, Front-line Lead).
    3. **EXTERNAL DATA NECESSITY & LOGICAL CONSISTENCY (CRITICAL)**: You MUST generate exactly one PDF file AND exactly one Excel file (.xlsx) unless it is completely impossible for the business context. The files generated MUST be external data (not inside the current system) and MUST be unstructured or semi-structured in format.
        - **LOGICAL LINKAGE**: ALL discrepancies or specific transaction IDs (e.g., "INV-7829") mentioned in the external file content MUST correspond to standard records that ACTUALLY EXIST inside the generated BigQuery CSV tables. Do NOT make up transaction IDs in the external file that do not exist in the database tables. This allows the user to find the anomaly by comparing the external file against the database.
    3. **FILE FORMAT & REALISM (CRITICAL)**: 
        - For PDF files, generate **substantial, realistic, and highly structured business document content (at least 1,500 characters)** with clear titles, multiple sections using Markdown headings (e.g., '# Summary', '## Background', '### Details'), and bullet points ('- '). It MUST be unstructured text in a rich report format. 
            - **CHART TRANSLATION**: ${chartTranslationClause}
            - **MARKDOWN LIMITATIONS**: Only use Markdown for structural elements: headings ('#', '##', '###') and lists ('-'). **DO NOT use inline styles like bold ('**bold**') or italics ('*italics*') within running text**, as the simple PDF renderer cannot interpret partial styles inside a single line. Standard running text should be plain sentences.
            - **Rich Visuals**: Include at least one data chart placeholder in the format '[CHART: Title, Metric1=Value1, Metric2=Value2, ...]' to simulate visuals. Do NOT use simple CSV or tiny tables for PDFs!
        - For Excel files, ensure the fileName ends with '.xlsx' and provide **complex, semi-structured datasets in TSV (Tab-separated values) format using \t as a delimiter** that simulate real business spreadsheets (MANDATORY: Generate 40 to 80 rows of detail data. DO NOT summarize or truncate. Replicate a realistic full set of logs/records).
            - **SEPARATORS (CRITICAL)**: **Use \t (Tab) as the column separator**, NOT commas. Commas are reserved for human-friendly currency formatting within fields.
            - **COMPOSITE LAYOUT**: Include a report title and a Summary KPI section at the top, a blank line list separator, and then the Detailed Data table below.
            - **HARDCODED UNITS & FORMATTING**: Include units (e.g., 円, L, kg, %) inside the data cells itself as strings. Use thousand-comma separators for money values — this is permitted and safe since you are using Tabs as separators! (e.g., "150,000円").
            - **RICH QUALITATIVE COMMENTS**: Include a "Remarks/Notes" column with realistic, verbose business comments (e.g., "Delayed due to traffic accident on Route 1").
    4. **NO TABLES/COLUMNS**: Do NOT mention 'production_batches', 'port_id', etc. in the prompt text.
    5. **GEOSPATIAL SYNERGY**: At least one scene's **The Prompt:** (and matching **scenarioPrompts** entry) MUST require the agent to use BOTH system data (for historical metrics) and location/map data (for travel times, routes, or place details). Use generic terms like 'location data' or 'map information' instead of 'Google Maps'.
    5. **PROBLEM-CENTRIC**: Focus on high-level business goals (e.g., "Identify the financial impact of logistics delays in coastal regions and propose an optimized route for the highest-value shipments").
- **DATA STORYTELLING & ANOMALIES (CRITICAL)**: You MUST seed at least one complex business anomaly across the tables. For example, a specific product category having a high return rate only in a specific region during a specific week, which correlates with a delivery carrier listed in the external log file. Do not make it obvious; the agent should need to join at least two tables and analyze trends to find it.
- **FACTOR ADHERENCE (CRITICAL)**: The generated CSV data MUST strictly adhere to the patterns described in \`appliedFactors\` in your JSON response. If you list 'Temporal Pattern: Weekday lunch surge', the timestamped transaction data MUST show higher volumes during those hours.
- **MAXIMUM DATA (CRITICAL)**: You MUST generate **exactly ${maxRows} rows** for every table. Do NOT use "etc.", "...", or any placeholder to truncate data. This is a technical requirement for a simulation.
- **RELATIONAL INTEGRITY & NAMING**: 
    1. **Primary/Foreign Keys MUST follow the format '[entity]_id'** (e.g., 'talent_id', 'theater_id').
    2. **STRICT SYMMETRY**: Foreign Keys MUST have the EXACT same name as the Primary Key they reference. Do NOT use prefixes like 'main_' or 'ref_' for ID columns.
    3. **STAR SCHEMA PREFERENCE**: When generating multiple tables, favor a "Star Schema" approach. Include at least one central "Dimension/Master" table (e.g., 'products', 'locations', 'customers') that other "Fact/Log" tables reference. This ensures better data connectivity and analytical depth.
    4. **NO ISOLATED TABLES (CRITICAL)**: Every table MUST be connected to at least one other table. Isolated tables (islands) are strictly forbidden. Ensure that all tables can be joined together directly or through an intermediary table.
    5. Tables MUST be designed for joining.
${languageConsistencyRules}
- **TECHNICAL NAMES (CRITICAL)**: Table names, column names, and ALL ID fields (primary/foreign keys) MUST use English (snake_case) for technical compatibility and data integrity. Do NOT translate technical identifiers.
- **ABSTRACT INSTRUCTIONS**: Do NOT mention column names in prompts.
- **STRICT CSV FORMATTING**: 
    1. **ALWAYS wrap text-based values** (STRING) in double quotes.
    2. **DO NOT wrap numeric values** (INTEGER, FLOAT) in quotes.
`;
}

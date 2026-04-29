/**
 * GE Demo Generator - Backend
 * 
 * Dynamically generates a portable AI agent demo environment 
 * using BigQuery and Maps MCP servers.
 */

// ===========================================
// Configuration
// ===========================================

const SCRIPT_PROPS = PropertiesService.getScriptProperties();
const CONFIG = {
  PROJECT_ID: SCRIPT_PROPS.getProperty('PROJECT_ID'),
  LOCATION: SCRIPT_PROPS.getProperty('LOCATION') || 'global',
  MODEL: SCRIPT_PROPS.getProperty('MODEL') || 'gemini-3.1-pro-preview',
  LOG_SHEET_URL: SCRIPT_PROPS.getProperty('LOG_SHEET_URL'),
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  APP_VERSION: 'v1.0'
};

/** In-memory cache for service account access token (valid within a single execution). */
var _vertexSaTokenCache = { token: '', expMs: 0 };



// ===========================================
// Utility & Diagnostics
// ===========================================

function forceAuthorizeSpreadsheet() {
  const dummySheetUrl = 'https://docs.google.com/spreadsheets/d/1Usj83O0qT2nIoaeyXbn5IqPY2KVdaV2G3UP_suBmIaw/edit';
  try {
    const ss = SpreadsheetApp.openByUrl(dummySheetUrl);
    console.log('[AUTH-FORCE] Successfully opened dummy sheet. If you see this, you are authorized!');
    return JSON.stringify({ success: true, message: 'Authorization forced. Check Logger logs if it works!' });
  } catch (e) {
    if (e.message.includes('権限')) {
      console.log('[AUTH-FORCE] Authority error found. This is expected if you are not yet authorized. Running this function should have triggered the popup!');
      throw new Error('Please click Review Permissions to authorize Spreadsheet access.');
    } else {
      console.log('[AUTH-FORCE] Unknown error: ' + e.message);
      return JSON.stringify({ success: false, error: 'Unexpected error: ' + e.message });
    }
  }
}

function resetAllUserProperties() {
  const props = PropertiesService.getUserProperties();
  props.deleteAllProperties();
  console.log('[STORAGE-RESET] All UserProperties cleared successfully.');
  return JSON.stringify({ success: true, message: 'All UserProperties cleared.' });
}


// ===========================================
// Web App Entry Point
// ===========================================
function doGet() {
  const configError = checkConfiguration();
  if (configError) {
    const template = HtmlService.createTemplateFromFile('SetupError');
    template.errorMessage = configError;
    return template.evaluate()
      .setTitle('Setup Required - GE Demo Generator')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }

  const template = HtmlService.createTemplateFromFile('index');
  
  template.appVersion = CONFIG.APP_VERSION;
  template.updateLog = JSON.stringify(fetchGitLogs());
  template.projectId = CONFIG.PROJECT_ID;
  template.userEmail = Session.getActiveUser().getEmail();
  
  return template.evaluate()
    .setTitle('Gemini Enterprise Demo Generator')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Validates that all required script properties are set.
 * Returns an error message if missing, or null if valid.
 */
function checkConfiguration() {
  const missing = [];
  if (!CONFIG.PROJECT_ID) missing.push('PROJECT_ID');
  if (!CONFIG.LOG_SHEET_URL) missing.push('LOG_SHEET_URL');
  
  if (missing.length > 0) {
    return 'The following mandatory Script Properties are missing: ' + missing.join(', ') + 
           '. Please run initializeProject() from the Apps Script editor or set them manually in Project Settings.';
  }
  return null;
}


function checkSpreadsheet() {
  if (!CONFIG.LOG_SHEET_URL) {
    return JSON.stringify({ success: false, error: 'No LOG_SHEET_URL configured' });
  }
  try {
    const ss = SpreadsheetApp.openByUrl(CONFIG.LOG_SHEET_URL);
    return JSON.stringify({ success: true, message: 'Logger Sheet Connected: ' + ss.getName() });
  } catch (e) {
    return JSON.stringify({ success: false, error: 'Failed to access sheet: ' + e.message });
  }
}

/**
 * One-time initialization function to set up Script Properties.
 * Run this from the Apps Script editor after setting your values.
 * 
 * @param {string} projectId - Your Google Cloud Project ID
 * @param {string} logSheetUrl - URL of your usage log spreadsheet (optional)
 */
function initializeProject(projectId, logSheetUrl) {
  if (!projectId) {
    throw new Error('PROJECT_ID is mandatory for initialization.');
  }

  const scriptProps = PropertiesService.getScriptProperties();
  const currentProps = scriptProps.getProperties();

  const newProps = {
    PROJECT_ID: projectId, 
    LOCATION: currentProps.LOCATION || 'global',
    MODEL: currentProps.MODEL || 'gemini-3.1-pro-preview',
    LOG_SHEET_URL: logSheetUrl || currentProps.LOG_SHEET_URL || ''
  };
  
  // Scopes detection (SpreadsheetApp)
  try { if (newProps.LOG_SHEET_URL) SpreadsheetApp.openByUrl(newProps.LOG_SHEET_URL); } catch(e) {}
  
  scriptProps.setProperties(newProps);
  console.log('Project initialized. Properties updated: ' + Object.keys(newProps).join(', '));
  return 'Initialization complete. Properties set/merged: ' + Object.keys(newProps).join(', ');
}

function logUsageToSheet(logEntry) {
  console.log('[LOGGING] Attempting to log usage. LOG_SHEET_URL length:', CONFIG.LOG_SHEET_URL ? CONFIG.LOG_SHEET_URL.length : 0);
  
  if (!CONFIG.LOG_SHEET_URL) {
    console.log('[LOGGING] No LOG_SHEET_URL configured, skipping spreadsheet log.');
    return;
  }
  
  try {
    console.log('[LOGGING] Opening spreadsheet...');
    const ss = SpreadsheetApp.openByUrl(CONFIG.LOG_SHEET_URL);
    console.log('[LOGGING] Spreadsheet opened:', ss.getName());
    let sheet = ss.getSheetByName('Usage_Logs');
    if (!sheet) {
      sheet = ss.insertSheet('Usage_Logs');
      console.log('[LOGGING] Created Usage_Logs sheet.');
    }
    console.log('[LOGGING] Logging to sheet tab:', sheet.getName());
    
    const timestamp = new Date().toISOString();
    const userEmail = Session.getActiveUser().getEmail();
    
    const durationSecs = Math.floor(logEntry.durationMs / 1000);
    const mins = Math.floor(durationSecs / 60);
    const secs = durationSecs % 60;
    const durationStr = `${mins}m ${secs}s`;

    const rowData = [
      timestamp,
      userEmail,
      logEntry.datasetId || 'N/A',
      logEntry.status || 'N/A',
      durationStr,
      logEntry.rowCount || 0,
      logEntry.tableCount || 0,
      logEntry.publicDatasetFlag ? 'Yes' : 'No',
      logEntry.tableNames || 'N/A',
      logEntry.errorClass || 'N/A'
    ];

    // If empty sheet, write header
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'User Email', 'Dataset ID', 'Status', 'Duration', 'Req. Rows', 'Req. Tables', 'Public Dataset', 'Table Names', 'Error Class']);
    }
    
    sheet.appendRow(rowData);
    SpreadsheetApp.flush();
    
    // Convert User Email cell to People Smart Chip using Advanced Service
    try {
      const lastRow = sheet.getLastRow();
      const sheetId = sheet.getSheetId();
      const spreadsheetId = ss.getId();
      
      const requests = [
        {
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: lastRow - 1,
              endRowIndex: lastRow,
              startColumnIndex: 1,
              endColumnIndex: 2
            },
            rows: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: "@" },
                    chipRuns: [
                      {
                        startIndex: 0,
                        chip: {
                          personProperties: {
                            email: userEmail,
                            displayFormat: "EMAIL"
                          }
                        }
                      }
                    ]
                  }
                ]
              }
            ],
            fields: "userEnteredValue,chipRuns"
          }
        }
      ];
      
      Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheetId);
    } catch (chipErr) {
      console.warn('⚠️ Could not insert People Chip via Advanced Service:', chipErr.message);
    }
    
    console.log('[LOGGING] Successfully logged usage to sheet. Data row:', rowData);
  } catch (e) {
    console.error('[LOGGING] Failed to log usage to sheet:', e.message);
  }
}

/**
 * Main function to generate the demo artifacts
 */
function generateDemo(userGoal, options = {}) {
  const startTime = Date.now();
  const defaultOptions = {
    rowCount: 100,
    tableCount: 3,
    publicDatasetId: null,
    usePublicDataset: false,
    useGoogleWorkspace: false
  };
  options = { ...defaultOptions, ...options };

  // Normalise frontend key name (enableWorkspaceTools) to internal key (useGoogleWorkspace)
  if (options.enableWorkspaceTools !== undefined) {
    options.useGoogleWorkspace = options.enableWorkspaceTools;
  }
  
  if (!options.usePublicDataset) {
    options.publicDatasetId = null;
  }
  
  const result = {
    success: false,
    steps: [],
    error: null,
    datasetId: null,
    tableInfo: [],
    dataPreview: [],
    systemInstruction: null,
    setupScript: null,
    rawTables: [],
    suffix: null,
    domainName: null,
    referenceDate: null,
    appliedFactors: null
  };
  
  try {
    // Step 1: Planning and Data Generation
    result.steps.push({ step: 1, status: 'running', message: 'Planning & generating data...' });
    const planResult = planAndGenerateData(userGoal, options);
    result.steps[0] = { step: 1, status: 'completed', message: 'Planning complete' };
    
    // Step 2: Validation
    result.steps.push({ step: 2, status: 'running', message: 'Validating generated data...' });
    const maxRows = Math.min(options.rowCount || 100, 150);
    validateGeneratedData(planResult, maxRows);
    result.steps[1] = { step: 2, status: 'completed', message: 'Validation complete' };
    
    // Step 3: Suffix generation
    const suffix = Utilities.getUuid().replace(/-/g, '').substring(0, 8);
    const baseName = generateBaseName(userGoal, suffix);
    const dirName = "demo-" + baseName;
    const datasetId = ("demo_" + baseName).replace(/-/g, '_');
    
    result.datasetId = datasetId;
    result.userGoal = userGoal;
    result.dataPreview = planResult.dataPreview;
    result.rawTables = planResult.tables;
    result.suffix = suffix;
    result.domainName = baseName.substring(0, baseName.lastIndexOf('-' + suffix));
    result.dirName = dirName;
    result.systemInstruction = planResult.systemInstruction;
    result.referenceDate = planResult.referenceDate;
    result.publicDatasetId = planResult.publicDatasetId;
    result.demoGuide = planResult.demoGuide;
    result.externalFiles = planResult.externalFiles || [];
    result.appliedFactors = planResult.appliedFactors || {};

    result.setupScript = generateSetupScript({
      datasetId: datasetId,
      systemInstruction: planResult.systemInstruction,
      referenceDate: planResult.referenceDate,
      publicDatasetId: planResult.publicDatasetId,
      suffix: suffix,
      dirName: dirName,
      tables: planResult.tables,
      userGoal: userGoal,
      useGoogleWorkspace: options.useGoogleWorkspace
    });
    result.steps.push({ step: 4, status: 'completed', message: 'Generation complete' });
    
    result.success = true;
    
    
    // Save to telemetry and log to sheet
    const durationMs = Date.now() - startTime;
    const telemetry = {
      datasetId: datasetId,
      status: 'Success',
      durationMs: durationMs,
      rowCount: options.rowCount,
      tableCount: options.tableCount,
      publicDatasetFlag: options.usePublicDataset,
      tableNames: result.rawTables ? result.rawTables.map(t => t.tableName).join(', ') : 'N/A',
      errorClass: null
    };

    try {
      logUsageToSheet(telemetry);
    } catch (logErr) {
      console.error('[LOGGING-CRITICAL] Failed to log usage to sheet in generate:', logErr.message);
    }
    
  } catch (error) {
    result.error = error.message;
    const lastStep = result.steps[result.steps.length - 1];
    if (lastStep) {
      lastStep.status = 'error';
      lastStep.message = error.message;
    }
    
    // Log failure telemetry
    const durationMs = Date.now() - startTime;
    const failureTelemetry = {
      datasetId: result.datasetId || 'Unknown',
      status: 'Failure',
      durationMs: durationMs,
      rowCount: options.rowCount,
      tableCount: options.tableCount,
      publicDatasetFlag: options.usePublicDataset,
      tableNames: result.rawTables ? result.rawTables.map(t => t.tableName).join(', ') : 'N/A',
      errorClass: error.message
    };
    try {
      logUsageToSheet(failureTelemetry);
    } catch (logErr) {
      console.error('[LOGGING-CRITICAL] Failed to log failure to sheet:', logErr.message);
    }
  }
  
  return result;
}

// ===========================================
// Step 1: Planning and Data Generation
// ===========================================

/**
 * Discovers a real BigQuery public dataset ID using Google Search grounding,
 * then verifies the table exists using the BigQuery API.
 * @param {string} userGoal - The user's business problem description.
 * @returns {string} A verified public dataset ID or a fallback.
 */
function discoverPublicDataset(userGoal) {
  const discoveryPrompt = `Find a real BigQuery public dataset that would provide EXTERNAL CONTEXT or ENRICHMENT for the following business problem:

"${userGoal}"

Requirements:
1. The dataset MUST exist under the project 'bigquery-public-data'.
2. Search Google to find the exact dataset and table names.
3. PRIORITIZE "External Context" data: weather, demographics, census, economic indicators, geographic features, or market statistics.
4. AVOID "Core Business" data: Do NOT select datasets that look like internal company records (e.g., avoid order histories, customer lists, or internal transactions) unless explicitly required for external benchmarking.
5. Return ONLY the fully qualified ID in the format: bigquery-public-data.dataset_name.table_name
6. If multiple tables exist, choose the most commonly used or primary one.
7. Do NOT invent or hallucinate dataset names.

Examples of preferred "External Context" datasets:
- bigquery-public-data.noaa_gsod.gsod2023 (Weather)
- bigquery-public-data.census_bureau_acs.zip_codes_2018_5yr (Demographics)
- bigquery-public-data.geo_open_streets.lines (Geographic)
- bigquery-public-data.google_trends.top_terms (Market Trends)

Return ONLY the dataset ID, nothing else.`;

  const FALLBACK = 'bigquery-public-data.thelook_ecommerce.orders';

  try {
    const result = callVertexAIWithSearch(discoveryPrompt);
    const cleanId = result.trim().replace(/[`'"]/g, '').split('\n')[0];
    
    if (!cleanId.startsWith('bigquery-public-data.') || cleanId.split('.').length < 3) {
      return FALLBACK;
    }
  
    const verifiedId = verifyAndResolveTable(cleanId);
    return verifiedId || FALLBACK;
  } catch (e) {
    return FALLBACK;
  }
}

/**
 * Verifies a table exists in BigQuery. If the exact table doesn't exist,
 * attempts to find a valid table in the same dataset.
 * @param {string} candidateId - Fully qualified ID (project.dataset.table)
 * @returns {string|null} Verified table ID or null if not found.
 */
function verifyAndResolveTable(candidateId) {
  const parts = candidateId.split('.');
  if (parts.length < 3) return null;
  
  const projectId = parts[0];
  const datasetId = parts[1];
  const tableId = parts.slice(2).join('.'); 
  
  try {
    BigQuery.Tables.get(projectId, datasetId, tableId);
    return candidateId;
  } catch (e) {}
  
  try {
    const tables = BigQuery.Tables.list(projectId, datasetId, { maxResults: 20 });
    if (tables.tables && tables.tables.length > 0) {
      const preferredPatterns = ['trips', 'orders', 'events', 'data', 'stats', 'records'];
      let match = null;
      for (const pattern of preferredPatterns) {
        match = tables.tables.find(t => t.tableReference.tableId.toLowerCase().includes(pattern));
        if (match) break;
      }
      if (!match) match = tables.tables[0];
      
      return `${projectId}.${datasetId}.${match.tableReference.tableId}`;
    }
  } catch (listError) {}
  
  return null;
}


function planAndGenerateData(userGoal, options) {
  // Step 0: If using public dataset and no ID specified, discover one using search grounding
  if (options.usePublicDataset && !options.publicDatasetId) {
    options.publicDatasetId = discoverPublicDataset(userGoal);
  }
  
  const prompt = buildPlanningPrompt(userGoal, options);
  const response = callVertexAIWithRetry(prompt);
  
  let parsed;
  try {
    let jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    jsonStr = repairTruncatedJson(jsonStr);
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error('Failed to parse AI response. Try reducing the row/table count.');
  }
  
  // Extract preview
  const dataPreview = [];
  if (parsed.tables) {
    for (const table of parsed.tables) {
      if (table.csvData) {
        const lines = table.csvData.trim().split('\n');
        const headers = parseCSVLine(lines[0]);
        const previewRows = lines.slice(1).map(line => {
          const values = parseCSVLine(line);
          const row = {};
          headers.forEach((h, i) => { row[h.trim().replace(/^"|"$/g, '')] = values[i] || ''; });
          return row;
        });
        dataPreview.push({
          tableName: table.tableName,
          headers: headers.map(h => h.trim().replace(/^"|"$/g, '')),
          rows: previewRows,
          totalRows: lines.length - 1
        });
      }
    }
  }
  
  // Validation and Clean-up
  validateGeneratedData(parsed, options.rowCount);

  return {
    tables: parsed.tables,
    systemInstruction: parsed.systemInstruction,
    referenceDate: parsed.referenceDate || '2023-11-01',
    publicDatasetId: parsed.publicDatasetId || options.publicDatasetId,
    oneSentenceSummary: parsed.oneSentenceSummary || null,
    demoGuide: parsed.demoGuide,
    externalFiles: parsed.externalFiles || [],
    appliedFactors: parsed.appliedFactors || null,
    dataPreview: dataPreview
  };
}

function buildPlanningPrompt(userGoal, options) {
  const maxRows = Math.min(options.rowCount || 100, 150);
  const publicDatasetInfo = options.usePublicDataset && options.publicDatasetId 
    ? `- RELATED PUBLIC DATASET (ENRICHMENT ONLY): ${options.publicDatasetId}
       * ROLE: This dataset serves as EXTERNAL CONTEXT (e.g., weather, statistics) to enrich the core business data.
       * CONSTRAINT: DO NOT use this dataset as a replacement for core business operations (e.g., do not use public orders/customers if you are generating a retail demo).
       * JOIN STRATEGY: Link via common attributes like 'zip_code', 'category', 'region', or 'date' rather than internal system IDs.`
    : `- IMPORTANT: NO public dataset should be used for this demo. Focus ONLY on synthetic tables below. Do NOT attempt to JOIN with external public-data.`;
  
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
  "demoGuide": [
    {
      "title": "Descriptive title of the analysis (e.g., 'Geospatial Root Cause Analysis')",
      "prompt": "Full prompt for the user to copy. Rules: 1. Do NOT mention specific table or column names (the agent must find them). 2. Present as a complex business question. 3. Synergize system data analysis with location/geospatial capabilities if applicable. 4. NEVER use product names like 'BigQuery', 'Google Maps', 'Looker' in the prompt. Use generic terms like 'the system records', 'the map data', 'historical logs'. If a file is required, use generic phrasing ('the uploaded file'). 5. **PROMPT SOPHISTICATION**: Prompts must not be direct lookups. They must be open-ended, diagnostic, or strategic requiring multi-hop reasoning.",
      "requiredFileId": "file1 or empty",
      "tags": ["Select tags like 'Finance', 'Geospatial', 'Reconciliation'"]
    }
  ]
}

## Critical Notes
- **DEMO PROMPTS (CRITICAL)**: Generate EXACTLY 5 structured demo prompts that showcase the agent's "reasoning" and "tool-use" capabilities.
    - **NO FILENAMES (CRITICAL)**: DO NOT include specific file names or extensions (e.g., 'market_report_2024', 'data.tsv') in the prompt text. Use generic phrasing.
    1. **DISTRIBUTION & ADVANCED PROGRESSION (CRITICAL)**: At least 3 prompts MUST be "No file required". Generate prompts in a progressive advanced arc:
        - Prompt 1: Advanced Multi-Table Correlation (Join multiple tables right off the bat, no simple aggregations).
        - Prompt 2: Deep-dive Audit / Root Cause Analysis (Utilizing the generated Excel/TSV log file for verification).
        - Prompt 3: Unstructured Data Fusion (AWT - Utilizing the generated PDF report for cross-referencing).
        - Prompt 4: Geospatial Context (Map + DB).
        - Prompt 5: Executive Strategic "What-if" Scenario.
    2. **PERSONA ROTATION (CRITICAL)**: Vary the tone and perspective by rotating personas for each prompt (e.g., CFO, Ops Manager, Regional Director, Front-line Lead).
    3. **EXTERNAL DATA NECESSITY & LOGICAL CONSISTENCY (CRITICAL)**: You MUST generate exactly one PDF file AND exactly one Excel file (.xlsx) unless it is completely impossible for the business context. The files generated MUST be external data (not inside the current system) and MUST be unstructured or semi-structured in format.
        - **LOGICAL LINKAGE**: ALL discrepancies or specific transaction IDs (e.g., "INV-7829") mentioned in the external file content MUST correspond to standard records that ACTUALLY EXIST inside the generated BigQuery CSV tables. Do NOT make up transaction IDs in the external file that do not exist in the database tables. This allows the user to find the anomaly by comparing the external file against the database.
    3. **FILE FORMAT & REALISM (CRITICAL)**: 
        - For PDF files, generate **substantial, realistic, and highly structured business document content (at least 1,500 characters)** with clear titles, multiple sections using Markdown headings (e.g., '# Summary', '## Background', '### Details'), and bullet points ('- '). It MUST be unstructured text in a rich report format. 
            - **CHART TRANSLATION**: When including data chart placeholders '[CHART: Title, ... ]', you **MUST translate the Title and Metric Labels into the language of the business problem** (e.g., if the problem is in Japanese, translate 'Metrics' to Japanese).
            - **MARKDOWN LIMITATIONS**: Only use Markdown for structural elements: headings ('#', '##', '###') and lists ('-'). **DO NOT use inline styles like bold ('**bold**') or italics ('*italics*') within running text**, as the simple PDF renderer cannot interpret partial styles inside a single line. Standard running text should be plain sentences.
            - **Rich Visuals**: Include at least one data chart placeholder in the format '[CHART: Title, Metric1=Value1, Metric2=Value2, ...]' to simulate visuals. Do NOT use simple CSV or tiny tables for PDFs!
        - For Excel files, ensure the fileName ends with '.xlsx' and provide **complex, semi-structured datasets in TSV (Tab-separated values) format using \t as a delimiter** that simulate real business spreadsheets (MANDATORY: Generate 40 to 80 rows of detail data. DO NOT summarize or truncate. Replicate a realistic full set of logs/records).
            - **SEPARATORS (CRITICAL)**: **Use \t (Tab) as the column separator**, NOT commas. Commas are reserved for human-friendly currency formatting within fields.
            - **COMPOSITE LAYOUT**: Include a report title and a Summary KPI section at the top, a blank line list separator, and then the Detailed Data table below.
            - **HARDCODED UNITS & FORMATTING**: Include units (e.g., 円, L, kg, %) inside the data cells itself as strings. Use thousand-comma separators for money values — this is permitted and safe since you are using Tabs as separators! (e.g., "150,000円").
            - **RICH QUALITATIVE COMMENTS**: Include a "Remarks/Notes" column with realistic, verbose business comments (e.g., "Delayed due to traffic accident on Route 1").
    4. **NO TABLES/COLUMNS**: Do NOT mention 'production_batches', 'port_id', etc. in the prompt text.
    5. **GEOSPATIAL SYNERGY**: At least one prompt MUST require the agent to use BOTH system data (for historical metrics) and location/map data (for travel times, routes, or place details) to answer. Use generic terms like 'location data' or 'map information' instead of 'Google Maps'.
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
- **LANGUAGE CONSISTENCY (CRITICAL)**: Detect the language used in the "Business Problem" above. You MUST use this same language for ALL user-facing fields, including:
    - Table and Column descriptions
    - STRING values in the CSV data (e.g., product names, categories, person names, names of things)
    - systemInstruction
    - appliedFactors descriptions
    - demoGuide titles and prompts
    - externalFiles fileName and fileContent
- **TECHNICAL NAMES (CRITICAL)**: Table names, column names, and ALL ID fields (primary/foreign keys) MUST use English (snake_case) for technical compatibility and data integrity. Do NOT translate technical identifiers.
- **ABSTRACT INSTRUCTIONS**: Do NOT mention column names in prompts.
- **STRICT CSV FORMATTING**: 
    1. **ALWAYS wrap text-based values** (STRING) in double quotes.
    2. **DO NOT wrap numeric values** (INTEGER, FLOAT) in quotes.
`;
}

// ===========================================
// Step 2: Validation
// ===========================================

function validateGeneratedData(planResult, targetRows) {
  if (!planResult.tables || planResult.tables.length === 0) {
    throw new Error('No table definitions generated');
  }
  
  for (const table of planResult.tables) {
    if (!table.schema || !table.csvData) throw new Error(`Incomplete table data for "${table.tableName}"`);
    
    // Validate and repair CSV/Schema column count mismatch
    const lines = table.csvData.trim().split('\n');
    if (lines.length === 0) throw new Error(`Empty CSV data for "${table.tableName}"`);
    
    const csvHeaders = parseCSVLine(lines[0]);
    const schemaColumnCount = table.schema.length;
    const csvColumnCount = csvHeaders.length;
    
    if (csvColumnCount !== schemaColumnCount) {
      // console.log(`Column mismatch for "${table.tableName}": CSV has ${csvColumnCount} columns, schema has ${schemaColumnCount}. Repairing...`);
      
      // Rebuild schema from CSV headers, inferring types from existing schema or defaulting to STRING
      const schemaMap = {};
      for (const field of table.schema) {
        schemaMap[field.name.toLowerCase()] = field;
      }
      
      const repairedSchema = csvHeaders.map(headerName => {
        const normalizedName = headerName.trim().toLowerCase();
        if (schemaMap[normalizedName]) {
          return schemaMap[normalizedName];
        }
        // Default to STRING for unknown columns
        return { name: headerName.trim(), type: 'STRING', description: 'Auto-generated field' };
      });
      
      table.schema = repairedSchema;
      // console.log(`Repaired schema for "${table.tableName}" to ${repairedSchema.length} columns.`);
    }

    const expectedColumnCount = table.schema.length;
    
    // --- Row count threshold check ---
    const dataRowCount = lines.length - 1; // Exclude header
    const minExpectedRows = Math.min(10, Math.floor(targetRows * 0.2)); // Dynamic minimum threshold
    
    if (dataRowCount < minExpectedRows) {
      console.warn(`[CSV QUALITY] Table "${table.tableName}" has only ${dataRowCount} rows (expected at least ${minExpectedRows}). Data may be sparse.`);
    }

    // --- Per-row column validation and repair ---
    const repairedLines = [];
    let repairCount = 0;
    
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let parts = parseCSVLine(line);
      
      // Repair rows with wrong column count
      if (parts.length !== expectedColumnCount) {
        if (lineIdx === 0) {
          // Header row mismatch - this shouldn't happen after schema repair, but handle it
          console.warn(`[CSV REPAIR] Header row has ${parts.length} columns, expected ${expectedColumnCount}. Skipping repair.`);
        } else {
          // Data row mismatch - repair by padding or truncating
          if (parts.length < expectedColumnCount) {
            // Pad with empty values
            while (parts.length < expectedColumnCount) {
              parts.push('');
            }
          } else {
            // Truncate excess columns
            parts = parts.slice(0, expectedColumnCount);
          }
          repairCount++;
        }
      }
      repairedLines.push(parts);
    }
    
    if (repairCount > 0) {
      console.warn(`[CSV REPAIR] Repaired ${repairCount} malformed rows in "${table.tableName}".`);
    }


    // --- Row Count Validation ---
    // Note: We intentionally do NOT pad with generated placeholder data.
    // It's better to have fewer realistic rows than many fake placeholder values
    // like "theater_name_13" or "location_prefecture_14".
    const currentDataRows = repairedLines.length - 1; // Exclude header
    if (currentDataRows < targetRows) {
      console.warn(`[ROW COUNT] Table "${table.tableName}" has ${currentDataRows} rows (target: ${targetRows}). AI did not generate enough rows.`);
    }

    // --- Robust Data Cleaning & Type Validation ---
    let typeRepairCount = 0;
    const cleanedLines = repairedLines.map((parts, lineIdx) => {
      // Skip header row for type validation
      if (lineIdx === 0) {
        return parts.map(v => v.replace(/^"|"$/g, '')).map((v, colIdx) => {
          const field = table.schema[colIdx];
          const type = field ? field.type.toUpperCase() : 'STRING';
          if (['INTEGER', 'FLOAT', 'DOUBLE', 'NUMBER', 'INT64', 'FLOAT64'].includes(type)) {
            return v;
          }
          return `"${v.replace(/"/g, '""')}"`;
        }).join(',');
      }
      
      // Data rows: validate and repair each cell
      return parts.map((val, colIdx) => {
        const field = table.schema[colIdx];
        const type = field ? field.type.toUpperCase() : 'STRING';
        const columnName = field ? field.name : `col${colIdx}`;
        
        // Use the new validation helper
        const result = validateAndRepairValue(val, type, columnName, lineIdx - 1);
        if (result.repaired) {
          typeRepairCount++;
        }
        return result.value;
      }).map((v, colIdx) => {
        // Final Re-quoting as per BigQuery requirements
        const field = table.schema[colIdx];
        const type = field ? field.type.toUpperCase() : 'STRING';
        
        if (['INTEGER', 'FLOAT', 'DOUBLE', 'NUMBER', 'INT64', 'FLOAT64'].includes(type)) {
          return v; // Numbers stay unquoted
        }
        // Strings, Dates, etc. get strictly quoted
        return `"${v.replace(/"/g, '""')}"`;
      }).join(',');
    });
    
    if (typeRepairCount > 0) {
      console.warn(`[TYPE REPAIR] Fixed ${typeRepairCount} type violations in "${table.tableName}".`);
    }
    
    table.csvData = cleanedLines.join('\n');
  }
}

/**
 * Validates and repairs a cell value based on its declared type.
 * Returns the repaired value and whether repair was needed.
 * @param {string} value - The raw value
 * @param {string} type - The column type (INTEGER, FLOAT, DATE, STRING, etc.)
 * @param {string} columnName - Column name for context-aware defaults
 * @param {number} rowIndex - Row index for generating sequential defaults
 * @returns {{value: string, repaired: boolean}}
 */
function validateAndRepairValue(value, type, columnName, rowIndex) {
  const upperType = type.toUpperCase();
  const trimmedVal = value.trim();
  
  // Empty values are allowed (NULL)
  if (trimmedVal === '') {
    return { value: '', repaired: false };
  }
  
  switch(upperType) {
    case 'INT64':
    case 'INTEGER':
      // Check for range expressions like "51-100"
      const rangeMatch = trimmedVal.match(/^(\d+)\s*[-–—]\s*\d+$/);
      if (rangeMatch) {
        return { value: rangeMatch[1], repaired: true };
      }
      // Check for valid integer
      if (/^-?\d+$/.test(trimmedVal)) {
        return { value: trimmedVal, repaired: false };
      }
      // Try to extract a number
      const intMatch = trimmedVal.match(/-?\d+/);
      if (intMatch) {
        return { value: intMatch[0], repaired: true };
      }
      // Generate fallback
      return { value: generateDefaultValue(upperType, columnName, rowIndex), repaired: true };
      
    case 'FLOAT64':
    case 'FLOAT':
    case 'DOUBLE':
    case 'NUMBER':
      // Check for valid float
      if (/^-?\d*\.?\d+$/.test(trimmedVal)) {
        return { value: trimmedVal, repaired: false };
      }
      // Try to extract a number
      const floatMatch = trimmedVal.match(/-?\d+\.?\d*/);
      if (floatMatch) {
        return { value: floatMatch[0], repaired: true };
      }
      // Generate fallback
      return { value: generateDefaultValue(upperType, columnName, rowIndex), repaired: true };
      
    case 'DATE':
      // Check for valid date format YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedVal)) {
        return { value: trimmedVal, repaired: false };
      }
      // Try to extract a date pattern
      const dateMatch = trimmedVal.match(/\d{4}-\d{2}-\d{2}/);
      if (dateMatch) {
        return { value: dateMatch[0], repaired: true };
      }
      // Generate fallback
      return { value: generateDefaultValue(upperType, columnName, rowIndex), repaired: true };
      
    case 'TIMESTAMP':
    case 'DATETIME':
      // Accept ISO format or similar
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmedVal)) {
        return { value: trimmedVal, repaired: false };
      }
      // If it's a date, convert to timestamp
      const tsDateMatch = trimmedVal.match(/^(\d{4}-\d{2}-\d{2})$/);
      if (tsDateMatch) {
        return { value: `${tsDateMatch[1]} 00:00:00 UTC`, repaired: true };
      }
      // Generate fallback as timestamp
      return { value: generateDefaultValue('TIMESTAMP', columnName, rowIndex), repaired: true };
      
    default:
      // STRING type - accept as-is
      return { value: trimmedVal, repaired: false };
  }
}

/**
 * Generates a sensible default value for a given type and column.
 * @param {string} type - The column type
 * @param {string} columnName - Column name for context-aware generation
 * @param {number} rowIndex - Row index for sequential IDs
 * @returns {string} A valid default value
 */
function generateDefaultValue(type, columnName, rowIndex) {
  const upperType = type.toUpperCase();
  const lowerColName = columnName.toLowerCase();
  
  switch(upperType) {
    case 'INT64':
    case 'INTEGER':
      // ID columns get sequential values
      if (lowerColName.endsWith('_id') || lowerColName === 'id') {
        return String(rowIndex + 1);
      }
      // Count/quantity columns
      if (lowerColName.includes('count') || lowerColName.includes('quantity') || lowerColName.includes('num')) {
        return String(Math.floor(Math.random() * 100) + 1);
      }
      // Default integer
      return String(Math.floor(Math.random() * 1000));
      
    case 'FLOAT64':
    case 'FLOAT':
    case 'DOUBLE':
    case 'NUMBER':
      // Price/amount columns
      if (lowerColName.includes('price') || lowerColName.includes('amount') || lowerColName.includes('cost')) {
        return (Math.random() * 1000 + 10).toFixed(2);
      }
      // Rating/score columns
      if (lowerColName.includes('rating') || lowerColName.includes('score')) {
        return (Math.random() * 4 + 1).toFixed(1);
      }
      // Default float
      return (Math.random() * 100).toFixed(2);
      
    case 'DATE':
      // Generate a date within the past year
      const d = new Date();
      d.setDate(d.getDate() - Math.floor(Math.random() * 365));
      return d.toISOString().split('T')[0];
      
    case 'TIMESTAMP':
    case 'DATETIME':
      const dt = new Date();
      dt.setDate(dt.getDate() - Math.floor(Math.random() * 365));
      return dt.toISOString();
      
    default:
      // STRING type
      return `${columnName}_${rowIndex + 1}`;
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Handle escaped double quotes: ""
        current += '"';
        i++; // Skip the next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function repairTruncatedJson(jsonStr) {
  try { JSON.parse(jsonStr); return jsonStr; } catch (e) {}
  
  let fixed = jsonStr;
  const csvDataMatch = fixed.match(/"csvData"\s*:\s*"([^"]*?)$/s);
  if (csvDataMatch) {
    const lastNewline = fixed.lastIndexOf('\\n');
    if (lastNewline > 0) fixed = fixed.substring(0, lastNewline) + '"';
  }
  
  let openBraces = 0; let openBrackets = 0; let inString = false; let escaped = false;
  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') inString = !inString;
    else if (!inString) {
      if (char === '{') openBraces++; else if (char === '}') openBraces--;
      else if (char === '[') openBrackets++; else if (char === ']') openBrackets--;
    }
  }
  if (inString) fixed += '"';
  while (openBrackets > 0) { fixed += ']'; openBrackets--; }
  while (openBraces > 0) { fixed += '}'; openBraces--; }
  return fixed;
}

// ===========================================
// Step 4: Setup Script Generation (Portable version)
// ===========================================

/**
 * Generates a short, filesystem-safe base name from the user's goal.
 * @param {string} userGoal - The user's business problem description
 * @param {string} suffix - Unique suffix for collision avoidance
 * @returns {string} A short, descriptive base name (e.g. retail-inventory-abcd1234)
 */
function generateBaseName(userGoal, suffix) {
  // Use AI to generate a short English identifier
  const prompt = `Generate a short, filesystem-safe identifier (2-3 words, lowercase, hyphens only) that describes this business problem:

"${userGoal}"

Rules:
- Use ONLY lowercase letters and hyphens (no numbers, no special characters)
- Maximum 20 characters
- Must be descriptive of the business domain
- Examples: "retail-inventory", "bakery-sales", "hotel-booking", "logistics-fleet"

Return ONLY the name, nothing else.`;

  try {
    const result = callVertexAI(prompt);
    let cleanName = result.trim().toLowerCase()
      .replace(/[^a-z-]/g, '-')     // Replace non-alphabet/non-hyphen with hyphen
      .replace(/-+/g, '-')           // Collapse multiple hyphens
      .replace(/^-|-$/g, '')         // Remove leading/trailing hyphens
      .substring(0, 15);             // Limit length to 15 to stay under 26 total with suffix
    
    if (cleanName.length < 3) cleanName = 'demo-env';
    return `${cleanName}-${suffix}`;
  } catch (e) {
    return `env-${suffix}`;
  }
}

function generateSetupScript(params) {
  const { datasetId, systemInstruction, referenceDate, publicDatasetId, suffix, tables, userGoal, dirName, useGoogleWorkspace } = params;
  
  const escapedInstruction = systemInstruction
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\''")
    .replace(/\{/g, '{{')
    .replace(/\}/g, '}}')
    .replace(/\n/g, '\\n');

  // Build local BQ creation commands
  let bqCommands = `echo "🗄 Creating BigQuery Dataset: ${datasetId}..."\n`;
  bqCommands += `bq mk --dataset --location=US ${datasetId} 2>/dev/null || echo "    ✅ Dataset already exists."\n\n`;

  for (const table of tables) {
    const schemaStr = table.schema.map(f => `${f.name}:${f.type}`).join(',');
    bqCommands += `echo "📊 Table: ${table.tableName}..."\n`;
    bqCommands += `if bq show ${datasetId}.${table.tableName} >/dev/null 2>&1; then\n`;
    bqCommands += `  echo "    ✅ Table already exists, skipping load."\n`;
    bqCommands += `else\n`;
    bqCommands += `  echo "    📥 Loading sample data..."\n`;
    bqCommands += `  cat <<'__CSV_EOF__' > ${table.tableName}.csv\n${table.csvData}\n__CSV_EOF__\n`;
    bqCommands += `  bq load --source_format=CSV --skip_leading_rows=1 --allow_quoted_newlines --null_marker="" --quote='"' --encoding=UTF-8 --location=US ${datasetId}.${table.tableName} ${table.tableName}.csv ${schemaStr}\n`;
    bqCommands += `  rm ${table.tableName}.csv\n`;
    bqCommands += `  echo "    ✅ Loaded."\n`;
    bqCommands += `fi\n\n`;
  }

  // Robustly escape instruction for an unquoted bash heredoc
  const rawInstruction = systemInstruction.replace(/[\\$`]/g, match => '\\' + match);

  return `#!/bin/bash
# ===========================================
# BigQuery MCP Agent Demo - Setup Script
# Generated: ${new Date().toISOString()}
# Demo: ${dirName}
# ===========================================

set -e

# --- Network resiliency for package installation ---
echo "⚙️  Configuring robust network timeouts for package resolution..."
export UV_HTTP_TIMEOUT=600
export UV_RETRIES=10

${useGoogleWorkspace ? `
# --- Gmail Re-setup Mode ---
if [ "$1" = "--setup-gmail" ]; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
  echo ""
  echo "📧 Gmail OAuth Re-setup"
  echo "────────────────────────────────────────────────────────────────────────────"
  echo "  Go to: https://console.cloud.google.com/apis/credentials?project=\$PROJECT_ID"
  echo "  Create Credentials → OAuth client ID → Desktop app"
  echo "────────────────────────────────────────────────────────────────────────────"
  read -p "  OAuth Client ID: " GMAIL_CLIENT_ID
  read -p "  OAuth Client Secret: " GMAIL_CLIENT_SECRET

  if [ -z "\$GMAIL_CLIENT_ID" ] || [ -z "\$GMAIL_CLIENT_SECRET" ]; then
    echo "❌ Client credentials empty. Aborting."
    exit 1
  fi

  GMAIL_SECRET_ID="workspace-gmail-creds-${suffix}"
  GMAIL_CLIENT_JSON="/tmp/gmail_client_$$.json"
  printf '{"installed":{"client_id":"%s","client_secret":"%s","redirect_uris":["http://localhost"],"auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}}' \\
    "\$GMAIL_CLIENT_ID" "\$GMAIL_CLIENT_SECRET" > "\$GMAIL_CLIENT_JSON"

  ADC_FILE="\$HOME/.config/gcloud/application_default_credentials.json"
  ADC_BACKUP="/tmp/adc_backup_$$.json"
  [ -f "\$ADC_FILE" ] && cp "\$ADC_FILE" "\$ADC_BACKUP"

  echo ""
  echo "🌐 Starting Gmail OAuth flow..."
  echo "   Cloud Shell (GCE): gcloud will print a command — run it on your local Mac/PC,"
  echo "   then paste the resulting localhost:... URL back here."
  echo "   Local machine: a browser will open automatically."
  echo "   Keep this terminal open until you see a success message."
  echo ""

  # Capture all gcloud output so we can extract the saved credentials path.
  # On Cloud Shell/GCE, gcloud uses a remote-bootstrap flow and saves credentials
  # to a temp directory (e.g. /tmp/tmp.XXXXX/application_default_credentials.json)
  # rather than the standard ADC path — so we must read the path from gcloud's output.
  # Use tee so output is shown in real-time (critical for Cloud Shell URL prompt)
  # AND captured for later parsing.
  GCLOUD_AUTH_TMP="/tmp/gcloud_auth_out_\$\$.txt"
  set +e
  gcloud auth application-default login \\
    --client-id-file="\$GMAIL_CLIENT_JSON" \\
    --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.send 2>&1 | tee "\$GCLOUD_AUTH_TMP"
  GCLOUD_AUTH_STATUS=\${PIPESTATUS[0]}
  set -e
  GCLOUD_AUTH_OUT=\$(cat "\$GCLOUD_AUTH_TMP")
  rm -f "\$GCLOUD_AUTH_TMP"

  # Extract the actual path gcloud saved credentials to (format differs across environments).
  SAVED_CREDS_PATH=\$(echo "\$GCLOUD_AUTH_OUT" | sed -nE 's/.*Credentials saved to file: \\[([^]]+)\\].*/\\1/p' | tail -n 1)
  if [ -z "\$SAVED_CREDS_PATH" ]; then
    SAVED_CREDS_PATH=\$(echo "\$GCLOUD_AUTH_OUT" | sed -nE 's/.*Credentials saved to file: (\\/[^ ]+).*/\\1/p' | tail -n 1)
  fi
  if [ -z "\$SAVED_CREDS_PATH" ]; then
    # Fallback: check standard ADC path (local machine flow)
    SAVED_CREDS_PATH="\$ADC_FILE"
  fi

  GMAIL_CREDS_TMP="/tmp/gmail_creds_$$.json"
  if [ "\$GCLOUD_AUTH_STATUS" -eq 0 ] && [ -f "\$SAVED_CREDS_PATH" ] && grep -q '"refresh_token"' "\$SAVED_CREDS_PATH"; then
    cp "\$SAVED_CREDS_PATH" "\$GMAIL_CREDS_TMP"
  elif [ "\$GCLOUD_AUTH_STATUS" -ne 0 ]; then
    echo "⚠️  Gmail OAuth command did not finish successfully (exit: \$GCLOUD_AUTH_STATUS)."
  fi

  # Restore original ADC (prevents breaking BigQuery MCP credentials)
  if [ -f "\$ADC_BACKUP" ]; then
    mv "\$ADC_BACKUP" "\$ADC_FILE"
    echo "✅ Original cloud credentials restored."
  fi
  # Clean up temp client JSON and any temp creds file written by gcloud
  rm -f "\$GMAIL_CLIENT_JSON"
  [ "\$SAVED_CREDS_PATH" != "\$ADC_FILE" ] && rm -f "\$SAVED_CREDS_PATH"

  if [ -f "\$GMAIL_CREDS_TMP" ]; then
    echo "🔒 Storing Gmail credentials in Secret Manager..."
    if gcloud secrets describe "\$GMAIL_SECRET_ID" --project="\$PROJECT_ID" >/dev/null 2>&1; then
      gcloud secrets versions add "\$GMAIL_SECRET_ID" --data-file="\$GMAIL_CREDS_TMP" --project="\$PROJECT_ID"
    else
      gcloud secrets create "\$GMAIL_SECRET_ID" --data-file="\$GMAIL_CREDS_TMP" --project="\$PROJECT_ID"
    fi
    rm -f "\$GMAIL_CREDS_TMP"
    # Update .env
    if grep -q "GMAIL_CREDENTIALS_SECRET_ID" .env 2>/dev/null; then
      sed -i "s|GMAIL_CREDENTIALS_SECRET_ID=.*|GMAIL_CREDENTIALS_SECRET_ID=\\"\$GMAIL_SECRET_ID\\"|" .env
    else
      echo "GMAIL_CREDENTIALS_SECRET_ID=\\"\$GMAIL_SECRET_ID\\"" >> .env
    fi
    echo "✅ Gmail credentials updated. Restart the agent to apply."
  else
    echo "❌ Gmail auth was cancelled or failed. Re-run: bash setup-demo-${suffix}.sh --setup-gmail"
  fi
  exit 0
fi
` : ''}

# --- Cleanup Mode Handler ---
  if [ "$1" = "--cleanup" ] || [ "$1" = "-c" ]; then
    echo ""
    echo "========================================================="
    echo "🧹 DEMO CLEANUP MODE"
    echo "========================================================="
    echo ""
    echo "This will delete the following resources:"
    echo "  • BigQuery Dataset: ${datasetId}"
    echo "  • Maps API Key: MCP-Demo-Key-${suffix}"
    echo "  • Cloud Run Service: ${dirName} (if deployed)"
    echo "  • Agent Engine (Reasoning Engine) instance: ${dirName}"
    echo "  • Gemini Enterprise registration (App): ${dirName}"

    echo "  • Local Directory: ~/${dirName}"
    echo ""
    read -p "Are you sure you want to proceed? (y/n) " -n 1 -r
    echo
    if [[ ! \$REPLY =~ ^[Yy]$ ]]; then
      echo "Cleanup cancelled."
      exit 0
    fi
    
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
    
    echo ""
    echo "🗑️  Deleting BigQuery Dataset: ${datasetId}..."
    bq rm -r -f -d \$PROJECT_ID:${datasetId} 2>/dev/null && echo "   ✅ Dataset deleted." || echo "   ⚠️  Dataset not found or already deleted."
    
    echo ""
    echo "🔑 Deleting Maps API Key: MCP-Demo-Key-${suffix}..."
    KEY_NAME=$(gcloud alpha services api-keys list --filter="displayName:MCP-Demo-Key-${suffix}" --format="value(name)" 2>/dev/null || echo "")
    if [ ! -z "\$KEY_NAME" ]; then
      DELETED_ALL=true
      for KN in \$KEY_NAME; do
        gcloud alpha services api-keys delete "\$KN" --quiet 2>/dev/null || DELETED_ALL=false
      done
      if \$DELETED_ALL; then
        echo "   ✅ API Key deleted."
      else
        echo "   ⚠️  Failed to delete one or more API Keys."
      fi
    else
      echo "   ⚠️  API Key not found or already deleted."
    fi

    echo ""
    echo "🚀 Deleting Cloud Run service: ${dirName}..."
    gcloud run services delete ${dirName} --region=us-central1 --quiet 2>/dev/null && echo "   ✅ Cloud Run service deleted." || echo "   ⚠️  Service not found or already deleted."

    echo ""
    echo "🤖 Deleting Agent Engine (Reasoning Engine) instance..."
    TOKEN=\$(gcloud auth print-access-token)
    # Robust search: Try exact match first, then suffix match
    RE_NAME=\$(curl -s -H "Authorization: Bearer \$TOKEN" -H "X-Goog-User-Project: \$PROJECT_ID" \
        "https://us-central1-aiplatform.googleapis.com/v1/projects/\$PROJECT_ID/locations/us-central1/reasoningEngines" | \
        jq -r --arg dir "${dirName}" --arg suf "${suffix}" '.. | objects | select(.displayName? == $dir or (.displayName? | strings | endswith($suf))) | .name' | head -n 1)
    
    if [ ! -z "\$RE_NAME" ] && [ "\$RE_NAME" != "null" ]; then
      RE_ID_NUM=\$(echo "\$RE_NAME" | grep -oE "[0-9]+$")
      curl -s -X DELETE -H "Authorization: Bearer \$TOKEN" -H "X-Goog-User-Project: \$PROJECT_ID" \
        "https://us-central1-aiplatform.googleapis.com/v1/\$RE_NAME?force=true" > /dev/null && echo "   ✅ Agent Engine instance deleted." || echo "   ⚠️  Failed to delete Agent Engine instance."
    else
      echo "   ⚠️  Agent Engine instance not found matching '${dirName}' or suffix '${suffix}'."
    fi

    echo ""
    echo "🌍 Deleting Gemini Enterprise registration (App/Agent)..."
    # Search all common locations
    for LOC in "global" "us" "eu"; do
      ENGINES_JSON=$(curl -s -H "Authorization: Bearer \$TOKEN" -H "X-Goog-User-Project: \$PROJECT_ID" \
        "https://discoveryengine.googleapis.com/v1alpha/projects/\$PROJECT_ID/locations/\$LOC/collections/default_collection/engines")
      
      # 2. If no engine match, scan for individual agents within EXISTING engines in this location
      for E_NAME in $(echo "\$ENGINES_JSON" | jq -r '.engines[]? | .name'); do
        ASSISTANTS=$(curl -s -H "Authorization: Bearer \$TOKEN" -H "X-Goog-User-Project: \$PROJECT_ID" "https://discoveryengine.googleapis.com/v1alpha/\${E_NAME}/assistants")
        for A_NAME in $(echo "\$ASSISTANTS" | jq -r '.assistants[]? | .name'); do
          AGENTS_JSON=$(curl -s -H "Authorization: Bearer \$TOKEN" -H "X-Goog-User-Project: \$PROJECT_ID" "https://discoveryengine.googleapis.com/v1alpha/\${A_NAME}/agents?pageSize=100")
          TARGET_AGENT_NAME=$(echo "\$AGENTS_JSON" | jq -r --arg dir "${dirName}" --arg suf "${suffix}" --arg re "\$RE_ID_NUM" '.agents[]? | select(.displayName == $dir or (try (.displayName | strings | endswith($suf)) catch false) or ($re != "" and (try (.adkAgentDefinition.provisionedReasoningEngine.reasoningEngine | strings | contains($re)) catch false))) | .name' 2>/dev/null | head -n 1)
          
          if [ ! -z "\$TARGET_AGENT_NAME" ] && [ "\$TARGET_AGENT_NAME" != "null" ]; then
            echo "   🗑 Unregistering Gemini Enterprise Agent: \${TARGET_AGENT_NAME} (Location: \$LOC)..."
            curl -s --fail -X DELETE -H "Authorization: Bearer \$TOKEN" -H "X-Goog-User-Project: \$PROJECT_ID" \
              "https://discoveryengine.googleapis.com/v1alpha/\$TARGET_AGENT_NAME" > /dev/null && echo "   ✅ Gemini Enterprise Agent unlisted." || echo "   ⚠️  Failed to unlist Gemini Enterprise Agent."
            break 3
          fi
        done
      done
    done
    


    ${useGoogleWorkspace ? `
    echo ""
    echo "🔒 Deleting Gmail credentials secret from Secret Manager..."
    gcloud secrets delete "workspace-gmail-creds-${suffix}" --project=\$PROJECT_ID --quiet 2>/dev/null && echo "   ✅ Secret deleted." || echo "   ⚠️  Secret not found or already deleted."
    ` : ''}
    echo ""
    echo "📂 Deleting local directory and uv cache: ~/${dirName}..."
    cd ~
    rm -rf ~/${dirName}
    rm -rf ~/.cache/uv
    echo "   ✅ Directory and UV cache deleted."
    
    echo ""
    echo "========================================================="
    echo "✅ CLEANUP COMPLETE"
    echo "========================================================="
    exit 0
  fi

# --- 1. Project Detection & Confirmation ---
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT_ID" ]; then
  echo "❌ Error: No default project found in your environment."
  echo "Please run 'gcloud config set project [PROJECT_ID]' first."
  exit 1
fi

echo "========================================================="
echo "🚀 Target Project: $PROJECT_ID"
echo "📂 Target Dataset: ${datasetId}"
echo "========================================================="
read -p "Do you want to proceed with this project? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# --- 1.1 Authentication & Permissions Check ---
echo "🔐 Checking authentication..."
if ! gcloud auth application-default print-access-token >/dev/null 2>&1 || ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "❌ Error: Google Cloud credentials have expired or are missing."
  echo "💡 Please run the following commands to re-authenticate:"
  echo "    gcloud auth login"
  echo "    gcloud auth application-default login"
  echo "Then re-run this setup script."
  exit 1
fi
${useGoogleWorkspace ? `
# --- 1.1a Google Workspace Setup (REST APIs) ---
echo ""
echo "🗂️  Google Workspace integration is enabled."
echo "   The agent can post to Chat spaces, create Sheets/Docs, and optionally send Gmail."
echo ""

# Enable Workspace APIs
echo "🔧 Enabling Google Workspace APIs..."
gcloud services enable \\
  gmail.googleapis.com \\
  sheets.googleapis.com \\
  docs.googleapis.com \\
  slides.googleapis.com \\
  drive.googleapis.com \\
  chat.googleapis.com \\
  secretmanager.googleapis.com \\
  --project="$PROJECT_ID"
echo "✅ Workspace APIs enabled."
echo ""

# ── Google Chat: prompt for incoming webhook URL (zero-auth, always works) ────
echo "💬 Setting up Google Chat webhook (recommended — works out of the box)..."
echo "────────────────────────────────────────────────────────────"
echo "  1. Open Google Chat and choose or create a Space"
echo "  2. Click the space name → Apps & Integrations → Webhooks"
echo "  3. Click 'Add Webhook', give it a name, and copy the URL"
echo "────────────────────────────────────────────────────────────"
read -p "  Paste your Google Chat Webhook URL (or press Enter to skip): " CHAT_WEBHOOK_URL
echo ""
if [ -z "\$CHAT_WEBHOOK_URL" ]; then
  echo "⚠️  No webhook URL provided. Chat notifications will be disabled."
else
  echo "✅ Chat webhook configured."
fi

# ── Gmail: OAuth via gcloud --client-id-file (works in Cloud Shell and locally)
echo ""
echo "📧 Gmail send setup (OPTIONAL)"
echo "────────────────────────────────────────────────────────────────────────────"
echo "  gcloud credentials are blocked for Gmail in managed Workspace orgs."
echo "  Gmail requires a Desktop App OAuth client from your GCP project."
echo ""
echo "  Steps (one-time):"
echo "   1. https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
echo "   2. Create Credentials → OAuth client ID → Desktop app"
echo "   3. Copy the Client ID and Secret below"
echo ""
echo "  Skip this step — Chat, Sheets, and Docs work without it."
echo "  Re-run anytime: bash setup-demo-${suffix}.sh --setup-gmail"
echo "────────────────────────────────────────────────────────────────────────────"
read -p "  Set up Gmail now? (y/n): " SETUP_GMAIL
GMAIL_SECRET_ID=""

if [[ "\$SETUP_GMAIL" =~ ^[Yy]$ ]]; then
  read -p "  OAuth Client ID: " GMAIL_CLIENT_ID
  read -p "  OAuth Client Secret: " GMAIL_CLIENT_SECRET

  if [ -z "\$GMAIL_CLIENT_ID" ] || [ -z "\$GMAIL_CLIENT_SECRET" ]; then
    echo "⚠️  Client credentials empty — skipping Gmail."
  else
    # Write a temporary OAuth client JSON for gcloud
    GMAIL_CLIENT_JSON="/tmp/gmail_client_$$.json"
    printf '{"installed":{"client_id":"%s","client_secret":"%s","redirect_uris":["http://localhost"],"auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}}' \\
      "\$GMAIL_CLIENT_ID" "\$GMAIL_CLIENT_SECRET" > "\$GMAIL_CLIENT_JSON"

    # Back up existing ADC so BQ MCP credentials are preserved after this flow
    ADC_FILE="\$HOME/.config/gcloud/application_default_credentials.json"
    ADC_BACKUP="/tmp/adc_backup_$$.json"
    [ -f "\$ADC_FILE" ] && cp "\$ADC_FILE" "\$ADC_BACKUP"

    echo ""
    echo "🌐 Starting Gmail OAuth flow..."
    echo "   Cloud Shell (GCE): gcloud will print a command — run it on your local Mac/PC,"
    echo "   then paste the resulting localhost:... URL back here."
    echo "   Local machine: a browser will open automatically."
    echo "   Log in as the account the agent should send email as."
    echo "   Keep this terminal open until you see a success message."
    echo ""

    # Capture all gcloud output so we can extract the saved credentials path.
    # On Cloud Shell/GCE, gcloud uses a remote-bootstrap flow and saves credentials
    # to a temp directory (e.g. /tmp/tmp.XXXXX/application_default_credentials.json)
    # rather than the standard ADC path — so we must read the path from gcloud's output.
    # Use tee so output is shown in real-time (critical for Cloud Shell URL prompt)
    # AND captured for later parsing.
    GCLOUD_AUTH_TMP="/tmp/gcloud_auth_out_\$\$.txt"
    set +e
    gcloud auth application-default login \\
      --client-id-file="\$GMAIL_CLIENT_JSON" \\
      --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.send 2>&1 | tee "\$GCLOUD_AUTH_TMP"
    GCLOUD_AUTH_STATUS=\${PIPESTATUS[0]}
    set -e
    GCLOUD_AUTH_OUT=\$(cat "\$GCLOUD_AUTH_TMP")
    rm -f "\$GCLOUD_AUTH_TMP"

    # Extract the actual path gcloud saved credentials to (format differs across environments).
    SAVED_CREDS_PATH=\$(echo "\$GCLOUD_AUTH_OUT" | sed -nE 's/.*Credentials saved to file: \\[([^]]+)\\].*/\\1/p' | tail -n 1)
    if [ -z "\$SAVED_CREDS_PATH" ]; then
      SAVED_CREDS_PATH=\$(echo "\$GCLOUD_AUTH_OUT" | sed -nE 's/.*Credentials saved to file: (\\/[^ ]+).*/\\1/p' | tail -n 1)
    fi
    if [ -z "\$SAVED_CREDS_PATH" ]; then
      # Fallback: check standard ADC path (local machine flow)
      SAVED_CREDS_PATH="\$ADC_FILE"
    fi

    # Capture Gmail credentials before restoring the original ADC
    GMAIL_CREDS_TMP="/tmp/gmail_creds_$$.json"
    if [ "\$GCLOUD_AUTH_STATUS" -eq 0 ] && [ -f "\$SAVED_CREDS_PATH" ] && grep -q '"refresh_token"' "\$SAVED_CREDS_PATH"; then
      cp "\$SAVED_CREDS_PATH" "\$GMAIL_CREDS_TMP"
      GMAIL_SECRET_ID="workspace-gmail-creds-${suffix}"
    elif [ "\$GCLOUD_AUTH_STATUS" -ne 0 ]; then
      echo "⚠️  Gmail OAuth command did not finish successfully (exit: \$GCLOUD_AUTH_STATUS)."
    fi

    # Restore original ADC (critical — prevents breaking BigQuery MCP auth)
    if [ -f "\$ADC_BACKUP" ]; then
      mv "\$ADC_BACKUP" "\$ADC_FILE"
      echo "✅ Original cloud credentials restored."
    fi
    # Clean up temp client JSON and any temp creds file written by gcloud
    rm -f "\$GMAIL_CLIENT_JSON"
    [ "\$SAVED_CREDS_PATH" != "\$ADC_FILE" ] && rm -f "\$SAVED_CREDS_PATH"

    # Store Gmail credentials in Secret Manager
    if [ -f "\$GMAIL_CREDS_TMP" ]; then
      echo "🔒 Storing Gmail credentials in Secret Manager (secret: \$GMAIL_SECRET_ID)..."
      if gcloud secrets describe "\$GMAIL_SECRET_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
        gcloud secrets versions add "\$GMAIL_SECRET_ID" --data-file="\$GMAIL_CREDS_TMP" --project="$PROJECT_ID"
      else
        gcloud secrets create "\$GMAIL_SECRET_ID" --data-file="\$GMAIL_CREDS_TMP" --project="$PROJECT_ID"
      fi
      rm -f "\$GMAIL_CREDS_TMP"
      echo "✅ Gmail ready. The agent can send email."
    else
      echo "⚠️  Gmail auth was cancelled or failed. Re-run: bash setup-demo-${suffix}.sh --setup-gmail"
      GMAIL_SECRET_ID=""
    fi
  fi
else
  echo "⏭️  Skipping Gmail. Chat, Sheets, and Docs will still work."
fi
` : ''}

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null || echo "")
if [ -z "$PROJECT_NUMBER" ]; then
  echo "❌ Error: Could not retrieve project details. The project ID might be invalid or you lack permissions."
  exit 1
fi

echo "💾 Checking disk space..."
FREE_SPACE=$(df -k . | awk 'NR==2 {print $4}')
if [ "$FREE_SPACE" -lt 1048576 ]; then
  echo "⚠️  CRITICAL: Low disk space detected ($((FREE_SPACE/1024)) MB left)."
  echo "    Deployment will likely fail (needs ~1GB free)."
  echo "    Use the cleanup command to free up space:"
  echo "    bash \$0 --cleanup"
  echo ""
  read -p "Attempt to continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi

# --- 1.2 Deployment Choice ---
echo ""
echo "========================================================="
echo "🚀 DEPLOYMENT STRATEGY"
echo "========================================================="
echo "Select your deployment target:"
echo "  [1] Local (Recommended for quick testing via Cloud Shell)"
echo "      - Launches 'adk web' on a local port."
echo "      - Best for quick iteration."
echo ""
echo "  [2] Cloud Run (Public URL)"
echo "      - Deploys the agent to a public, unauthenticated URL."
echo "      - Automates API enablement, Docker build, and IAM roles."
echo "      - Warning: Organization policies may block public ingress."
echo ""
echo "  [3] Deploy to Gemini Enterprise"
echo "      - Automated Agent Engine deployment."
echo "      - Registers your agent to Gemini Enterprise."
echo ""
DEPLOY_CHOICE=""
while [[ ! "\$DEPLOY_CHOICE" =~ ^[1-3]$ ]]; do
  read -p "Enter Choice [1, 2 or 3]: " DEPLOY_CHOICE
  # Remove trailing carriage return in case of running in some environments like Cygwin or Cloud Shell with weird tty mapping
  DEPLOY_CHOICE=$(echo "\$DEPLOY_CHOICE" | tr -d '\\r\\n\\t ')
  if [[ ! "\$DEPLOY_CHOICE" =~ ^[1-3]$ ]]; then
    echo "⚠️  Invalid choice. Please enter 1, 2, or 3 explicitly."
  fi
done

# Immediate check for Gemini Enterprise
if [ "\$DEPLOY_CHOICE" = "3" ]; then
  echo ""
  echo "========================================================="
  echo "🤖 GEMINI ENTERPRISE PRE-DEPLOYMENT CHECK"
  echo "========================================================="
  echo "This option will automatically deploy to Agent Engine and"
  echo "register it to Gemini Enterprise."
  echo ""
  echo "⚠️  IMPORTANT: You MUST have a Gemini Enterprise instance"
  echo "   already created in this project."
  echo ""
  echo "If you haven't, please create one here first:"
  echo "https://console.cloud.google.com/gemini-enterprise/products?project=\$PROJECT_ID"
  echo ""
  read -p "Have you confirmed the instance exists? (y/n) " -n 1 -r
  echo
  if [[ ! \$REPLY =~ ^[Yy]$ ]]; then
      echo "Exiting. Please create the instance and run the script again."
      exit 1
  fi
fi

# --- 2. IAM & API Checks ---
echo "📡 Checking & Enabling APIs..."
gcloud services enable \\
  aiplatform.googleapis.com \\
  bigquery.googleapis.com \\
  apikeys.googleapis.com \\
  mapstools.googleapis.com \\
  discoveryengine.googleapis.com \\
  cloudresourcemanager.googleapis.com \\
  serviceusage.googleapis.com \\
  iam.googleapis.com \\
  cloudbilling.googleapis.com \\
  logging.googleapis.com \\
  monitoring.googleapis.com \\
  clouderrorreporting.googleapis.com \\
  telemetry.googleapis.com \\
  --project="$PROJECT_ID"

if [ "$DEPLOY_CHOICE" = "2" ]; then
  echo "📡 Enabling Cloud Run specific APIs..."
  gcloud services enable \\
    run.googleapis.com \\
    cloudbuild.googleapis.com \\
    artifactregistry.googleapis.com \\
    --project="$PROJECT_ID"
fi

# --- 2.1 Ensure Service Agent Ready ---
echo "🛡 Ensuring Reasoning Engine Service Agent exists..."
# Creating the service identity for AI Platform often triggers the specific RE SA as well
gcloud beta services identity create --service=aiplatform.googleapis.com --project="$PROJECT_ID" || true
# Give it a moment to stabilize
sleep 3

# --- 2.1 IAM Configuration for Reasoning Engine ---
echo "🔐 Configuring IAM permissions for Agent Engine..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
RE_SA="service-\${PROJECT_NUMBER}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"

# --- IAM Helper Functions ---
check_and_grant_role() {
  local project=$1
  local member=$2
  local role=$3
  local max_retries=3
  local retry_count=0
  
  while [ \$retry_count -lt \$max_retries ]; do
    echo "  Checking/Granting \$role..."
    gcloud projects add-iam-policy-binding "\$project" \\
      --member="serviceAccount:\$member" \\
      --role="\$role" --condition=None >/dev/null 2>&1 || true
    
    # Wait a moment for propagation before verification
    sleep 2
    
    # Verify the binding exists
    if gcloud projects get-iam-policy "\$project" \
        --flatten="bindings[].members" \
        --format="value(bindings.role)" \
        --filter="bindings.members:serviceAccount:\$member AND bindings.role:\$role" | grep -q "\$role"; then
      echo "    ✅ Core role confirmed."
      return 0
    fi
    
    retry_count=\$((retry_count + 1))
    echo "    ⚠️ Verification failed, retrying (\$retry_count/\$max_retries)..."
    sleep 3
  done
  echo "    ❌ ERROR: Failed to verify \$role after \$max_retries attempts."
  echo "       Please manually grant the role using this command:"
  echo "       gcloud projects add-iam-policy-binding \"\$project\" --member=\"serviceAccount:\$member\" --role=\"\$role\" --condition=None"
  return 1
}

# Grant specific roles required for MCP tool execution and BigQuery access
for ROLE in "roles/mcp.toolUser" "roles/bigquery.jobUser" "roles/bigquery.dataViewer" "roles/serviceusage.serviceUsageConsumer" "roles/storage.admin" "roles/iam.serviceAccountTokenCreator"; do
  check_and_grant_role "$PROJECT_ID" "\$RE_SA" "\$ROLE"
done
${useGoogleWorkspace ? `
# Grant Secret Manager access so the agent can read Gmail credentials at runtime
check_and_grant_role "$PROJECT_ID" "\$RE_SA" "roles/secretmanager.secretAccessor"
` : ''}

# If Cloud Run is selected, ensure the default compute service account has required permissions
if [ "$DEPLOY_CHOICE" = "2" ]; then
  echo "🔐 Configuring IAM permissions for Cloud Run Service Account..."
  COMPUTE_SA="\${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  for ROLE in "roles/mcp.toolUser" "roles/bigquery.jobUser" "roles/bigquery.dataViewer" "roles/serviceusage.serviceUsageConsumer" "roles/aiplatform.user" "roles/logging.logWriter" "roles/storage.admin" "roles/artifactregistry.writer" "roles/run.developer" "roles/iam.serviceAccountUser" "roles/iam.serviceAccountTokenCreator"; do
    check_and_grant_role "$PROJECT_ID" "\$COMPUTE_SA" "\$ROLE"
  done
fi

# Enable MCP services
echo "🔧 Enabling MCP services..."
gcloud beta services mcp enable bigquery.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true
gcloud beta services mcp enable mapstools.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true

# --- 2.2 User-level IAM Configuration (for Cloud Shell users) ---
echo "🔐 Configuring user permissions for local execution..."
USER_ACCOUNT=$(gcloud config get-value account 2>/dev/null)
# For Cloud Run deployment, the user needs roles to build and deploy
ROLES_TO_GRANT=("roles/mcp.toolUser" "roles/serviceusage.serviceUsageConsumer" "roles/storage.admin")
if [ "$DEPLOY_CHOICE" = "2" ]; then
  ROLES_TO_GRANT+=("roles/run.admin" "roles/cloudbuild.builds.builder" "roles/iam.serviceAccountUser" "roles/artifactregistry.admin")
fi

for ROLE in "\${ROLES_TO_GRANT[@]}"; do
  echo "  Granting \$ROLE to \$USER_ACCOUNT..."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \\
    --member="user:\$USER_ACCOUNT" \\
    --role="\$ROLE" --condition=None >/dev/null 2>&1 || true
  echo "    ✅ Done"
done

# Check for BQ permissions (with timeout to prevent hanging on new projects)
echo "🛡 Checking BigQuery permissions..."
CAN_MK_BQ=$(timeout 30 bq ls --project_id="$PROJECT_ID" 2>&1 || echo "timeout_or_error")
if [[ $CAN_MK_BQ == *"Access Denied"* ]]; then
  echo "❌ Error: Your account doesn't have BigQuery access in this project."
  exit 1
fi
echo "✅ BigQuery Permissions OK"

# --- 3. Data Provisioning ---
${bqCommands}

# --- 4. Project Setup (Flat Structure) ---
if [ -d "${dirName}" ]; then
  echo "📂 Removing existing directory ${dirName} for a clean setup..."
  rm -rf "${dirName}"
fi

echo "📦 Setting up project directory..."
mkdir -p ${dirName}/adk_agent/mcp_app
cd ${dirName}

# Generate requirements.txt
cat <<'__REQ_EOF__' > requirements.txt
google-adk>=1.0.0
google-genai>=1.9.0
python-dotenv>=1.0.0
vertexai>=1.0.0
db-dtypes>=1.0.0
google-cloud-storage>=2.14.0
${useGoogleWorkspace ? `google-api-python-client>=2.100.0
google-auth-httplib2>=0.2.0
google-cloud-secret-manager>=2.16.0` : ''}
__REQ_EOF__

# Generate pyproject.toml required for adk project type
cat <<'__PYPROJ_EOF__' > pyproject.toml
[project]
name = "mcp-agent"
version = "0.1.0"
dependencies = ["google-adk>=1.0.0", "google-genai>=1.9.0", "google-cloud-storage>=2.14.0"${useGoogleWorkspace ? ', "google-api-python-client>=2.100.0", "google-auth-httplib2>=0.2.0", "google-cloud-secret-manager>=2.16.0"' : ''}]
requires-python = ">=3.10,<3.13"
[tool.adk]
project_type = "agent"
__PYPROJ_EOF__

# Generate Dockerfile using uv for performance (PoC v9 style)
cat <<'__DOCKER_EOF__' > Dockerfile
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY requirements.txt pyproject.toml ./
RUN uv pip install --system -r requirements.txt
COPY . .
ENV PORT 8080
ENV GOOGLE_GENAI_USE_VERTEXAI=1
ENV PYTHONUNBUFFERED=1
CMD ["adk", "web", "adk_agent", "--host", "0.0.0.0", "--port", "8080"]
__DOCKER_EOF__

# --- 5. Environment Setup ---
echo "📦 Preparing environment..."
# We always prepare the environment regardless of choice to ensure local testing works
if ! command -v uv >/dev/null 2>&1; then
    echo "    installing uv via astral.sh..."
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
    # Add to current PATH for the rest of the script
    export PATH="\$HOME/.cargo/bin:\$PATH"
fi
# Set UV to copy mode to prevent cross-filesystem hardlink failures (os error 28)
export UV_LINK_MODE=copy
uv cache clean >/dev/null 2>&1
uv venv
if ! uv pip install --no-cache -r requirements.txt; then
  echo ""
  echo "❌ ERROR: Installation failed."
  echo "   This is often caused by 'No space left on device'."
  echo "   Please run 'bash $0 --cleanup' to free up space and try again."
  exit 1
fi


# --- 6. Generate Maps API Key ---
echo "🔑 Generating Maps API key..."
API_KEY_JSON=$(gcloud alpha services api-keys create --display-name="MCP-Demo-Key-${suffix}" \\
    --api-target=service=mapstools.googleapis.com \\
    --format=json 2>/dev/null || echo "")

if [ ! -z "$API_KEY_JSON" ]; then
    API_KEY=$(echo "$API_KEY_JSON" | grep -oP '"keyString": "\K[^"]+' 2>/dev/null || echo "$API_KEY_JSON" | grep '"keyString":' | cut -d '"' -f 4)
else
    API_KEY=$(gcloud alpha services api-keys list --filter="displayName:MCP-Demo-Key-${suffix}" --format="value(keyString)" 2>/dev/null || echo "")
fi

if [ -z "$API_KEY" ]; then
    echo "⚠️ Failed to auto-generate API key. Set it manually in .env."
    API_KEY="REPLACE_ME"
fi

# Create .env in the root
cat <<__ENV_EOF__ > .env
GOOGLE_GENAI_USE_VERTEXAI=1
GOOGLE_CLOUD_PROJECT="$PROJECT_ID"
GOOGLE_CLOUD_LOCATION="global"
DEMO_DATASET="${datasetId}"
MAPS_API_KEY="$API_KEY"
PYTHONUNBUFFERED=1
GRPC_ENABLE_FORK_SUPPORT=1
${useGoogleWorkspace ? `GMAIL_CREDENTIALS_SECRET_ID="\${GMAIL_SECRET_ID}"
GOOGLE_CHAT_WEBHOOK_URL="\${CHAT_WEBHOOK_URL}"` : ''}
__ENV_EOF__

# Symlink .env to packages for visibility
ln -sf ../.env adk_agent/.env
ln -sf ../../.env adk_agent/mcp_app/.env

# Ignore large directories to prevent Reason Engine payload bloating
cat <<'__GITIGNORE_EOF__' > adk_agent/.gitignore
.venv/
.venv
__pycache__/
*.pyc
*.pyo
.pytest_cache/
__GITIGNORE_EOF__

# Create __init__.py files for proper Python package structure
touch adk_agent/__init__.py
cat <<'__INIT_EOF__' > adk_agent/mcp_app/__init__.py
from . import agent
__INIT_EOF__
${useGoogleWorkspace ? `
# workspace_tools.py is generated below and imported by agent.py
` : ''}


# --- 7. Customizing Agent ---
echo "🔧 Configuring agent..."



cat <<'__TOOLS_EOF__' > adk_agent/mcp_app/tools.py
import os
import asyncio
import dotenv
import google.auth
import google.auth.transport.requests
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from google.adk.tools.mcp_tool.mcp_tool import MCPTool
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
import httpx
import anyio
import time
import uuid
from google.adk.tools import ToolContext
from google.genai import client as genai_client, types as genai_types
import json

_orig_default = json.JSONEncoder.default
def _patched_default(self, obj):
    if isinstance(obj, genai_types.Part):
        return obj.model_dump(exclude_none=True)
    return _orig_default(self, obj)
json.JSONEncoder.default = _patched_default



def get_project_id():
    """Robustly retrieves the project ID from env, .env, or credentials."""
    # 1. Direct env
    pid = os.getenv("GOOGLE_CLOUD_PROJECT")
    if pid: return pid
    
    # 2. Try loading .env from root or package
    dotenv.load_dotenv()
    pid = os.getenv("GOOGLE_CLOUD_PROJECT")
    if pid: return pid
    
    # 3. Fallback to auth default
    try:
        _, pid = google.auth.default()
        if pid: return pid
    except: pass
    return "UNKNOWN"

# =============================================================================
# 🛡️ Stability Patches for Reasoning Engine (Mandatory)
# =============================================================================

_orig_client_init = httpx.AsyncClient.__init__
def _patched_client_init(self, *args, **kwargs):
    kwargs['http2'] = False 
    # Use long timeouts for stable MCP sessions (300s)
    kwargs['timeout'] = httpx.Timeout(300.0, connect=60.0)
    return _orig_client_init(self, *args, **kwargs)

_token_cache = {"token": None, "expiry": 0}
_token_lock = asyncio.Lock()

async def _get_fresh_mcp_token():
    """Retrieves a fresh access token with async-safe caching."""
    global _token_cache
    async with _token_lock:
        now = time.time()
        if _token_cache["token"] and now < _token_cache["expiry"]:
            return _token_cache["token"]
        try:
            scopes = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/bigquery"]
            credentials, _ = google.auth.default(scopes=scopes)
            # Run blocking refresh in a thread to avoid stalling the event loop
            await anyio.to_thread.run_sync(credentials.refresh, google.auth.transport.requests.Request())
            _token_cache = {"token": credentials.token, "expiry": now + 1800}
            return credentials.token
        except: return ""

_orig_send = httpx.AsyncClient.send
async def _patched_send(self, request, *args, **kwargs):
    # BigQuery MCP Auth Injection
    if "bigquery.googleapis.com/mcp" in str(request.url):
        token = await _get_fresh_mcp_token()
        if token: request.headers['Authorization'] = f"Bearer {token}"
            
    # Execute actual request
    response = await _orig_send(self, request, *args, **kwargs)
    
    # Error Transmutation (Prevent crash on recoverable tool errors)
    if response.status_code in [400, 403] and "bigquery.googleapis.com/mcp" in str(request.url):
        try:
            body = await response.aread()
            if b'"jsonrpc":' in body: response.status_code = 200
            response._content = body
        except: pass
    return response

# Apply Stability Patches
try:
    # 1. HTTP/2 Disable for stability
    httpx.AsyncClient.__init__ = _patched_client_init
    httpx.AsyncClient.send = _patched_send
except Exception as e:
    print(f"  [DEBUG] Stability patches not applied: {e}")

# =============================================================================
# 🔧 MCP Toolset Configuration
# =============================================================================
def get_maps_mcp_url():
    """Returns the base Maps MCP URL."""
    return "https://mapstools.googleapis.com/mcp"

def get_bigquery_mcp_url():
    """Returns the project-scoped BigQuery MCP URL using a query parameter."""
    project_id = get_project_id()
    # Using ?project= query parameter as the header alone was insufficient for public datasets
    return f"https://bigquery.googleapis.com/mcp?project={project_id}"

def get_bigquery_mcp_toolset():
    """Creates a BigQuery MCP toolset. URL is project-scoped to ensure quota/perms."""
    project_id = get_project_id()
    url = get_bigquery_mcp_url()
    if project_id == "UNKNOWN":
        print("  [CRITICAL] GOOGLE_CLOUD_PROJECT is missing! MCP calls will likely fail.")
        
    return MCPToolset(connection_params=StreamableHTTPConnectionParams(
        url=url, 
        headers={"x-goog-user-project": project_id},
        timeout=300
    ))

def get_maps_mcp_toolset():
    """Creates a Google Maps MCP toolset."""
    dotenv.load_dotenv()
    maps_api_key = os.getenv('MAPS_API_KEY')
    project_id = get_project_id()
    url = get_maps_mcp_url()
    return MCPToolset(connection_params=StreamableHTTPConnectionParams(
        url=url,
        headers={
            "x-goog-api-key": maps_api_key
        },
        timeout=300
    ))


async def generate_image(prompt: str, tool_context: ToolContext) -> list:
    """Generates an image based on the given prompt.
    
    This tool creates visual assets like infographics, charts, or scenes. It automatically 
    stores the image in the current environment's artifact service (GCS or Local). It returns
    a list of google.genai.types.Part objects for native rendering in the Gemini Enterprise Chat UI.
    
    Args:
        prompt: A highly detailed, descriptive prompt for the image. Include stylistic instructions (e.g., 'photorealistic', 'flat design', 'neon corporate colors').
        
    Returns:
        A list of google.genai.types.Part objects, including a text part and an image part.
    """
    filename = f"image_{uuid.uuid4().hex[:8]}.png"
    
    import os
    import logging
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    client = genai_client.Client(
        vertexai=True, 
        location=location, 
        project=project,
        http_options={'api_version': 'v1'}
    )
    from google.genai import types
    
    try:
        # Generate image via the GenerateContent API
        result = await asyncio.to_thread(
            client.models.generate_content,
            model='gemini-3.1-flash-image-preview',
            contents=[
                types.Content(
                    role="user",
                    parts=[types.Part.from_text(text=prompt)]
                )
            ],
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE"],
                image_config=types.ImageConfig(
                    aspect_ratio="16:9",
                    output_mime_type="image/png",
                )
            )
        )
    except Exception as e:
        logging.error(f"API Error generating image: {e}")
        return [types.Part.from_text(text=f"API Error generating image: {str(e)}")]
    
    if not result.candidates or not result.candidates[0].content.parts:
        logging.warning(f"Failed to generate image for prompt: {prompt}")
        return [types.Part.from_text(text=f"Failed to generate image for prompt: {prompt}")]
        
    image_bytes = None
    for part in result.candidates[0].content.parts:
        if part.inline_data:
            image_bytes = part.inline_data.data
            break
            
    if not image_bytes:
        logging.warning(f"No image bytes found in the response for prompt: {prompt}")
        return [types.Part.from_text(text=f"No image bytes found in the response for prompt: {prompt}")]
    
    try:
        # Store image bytes in session state instead of GCS or artifact
        tool_context.session.state['pending_generated_image'] = image_bytes
        logging.info(f"Image generated and stored in session state.")
        return [types.Part.from_text(text=f"Image generated successfully and stored in session state.")]
    except Exception as e:
        logging.error(f"Image generated, but failed to store in session: {e}")
        return [types.Part.from_text(text=f"Image generated, but failed to store in session: {str(e)}")]
__TOOLS_EOF__

${useGoogleWorkspace ? `
# ── Generate workspace_tools.py ──────────────────────────────────────────────
cat <<'__WS_EOF__' > adk_agent/mcp_app/workspace_tools.py
"""
Google Workspace REST API Tools
================================
Provides Gmail, Google Chat, Google Sheets, Google Docs, Google Slides,
and Google Drive capabilities via the Google APIs Python client library.
Works on local deployments and Vertex AI Agent Engine (Reasoning Engine).

Auth strategy
─────────────
  Gmail              : User OAuth credentials. Locally uses ADC; on Agent Engine
                       fetches a stored credential JSON from Secret Manager.
  Chat               : Incoming webhook URL from GOOGLE_CHAT_WEBHOOK_URL env var.
                       No auth required beyond the URL itself.
  Sheets/Docs/Slides : ADC (service account on Agent Engine, user creds locally).
                       The SA creates files owned by itself and shares them via
                       the Drive API so anyone with the link can view them.
  Drive search       : ADC readonly scope — lists files visible to the SA.
"""

import os
import json
import base64
import anyio
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import google.auth
import google.auth.transport.requests
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────────────────────────────────────

def _project_id() -> str:
    pid = os.getenv("GOOGLE_CLOUD_PROJECT")
    if pid:
        return pid
    try:
        _, pid = google.auth.default()
        return pid or "UNKNOWN"
    except Exception:
        return "UNKNOWN"

def _sa_credentials(scopes: list):
    """Return ADC credentials (SA on Agent Engine, user locally)."""
    creds, _ = google.auth.default(scopes=scopes)
    if not creds.valid:
        creds.refresh(google.auth.transport.requests.Request())
    return creds

def _gmail_credentials():
    """
    Return user OAuth credentials for Gmail.

    Resolves in order:
      1. Secret Manager  – if GMAIL_CREDENTIALS_SECRET_ID is set (Agent Engine path)
      2. ADC             – works locally after:
                           gcloud auth application-default login \\
                             --scopes=.../cloud-platform,.../gmail.send
    """
    secret_id = os.getenv("GMAIL_CREDENTIALS_SECRET_ID", "").strip()
    if secret_id:
        try:
            from google.cloud import secretmanager
            from google.oauth2.credentials import Credentials as UserCreds
            sm_creds = _sa_credentials(["https://www.googleapis.com/auth/cloud-platform"])
            client = secretmanager.SecretManagerServiceClient(credentials=sm_creds)
            name = f"projects/{_project_id()}/secrets/{secret_id}/versions/latest"
            resp = client.access_secret_version(request={"name": name})
            info = json.loads(resp.payload.data.decode("utf-8"))
            creds = UserCreds.from_authorized_user_info(
                info, scopes=["https://www.googleapis.com/auth/gmail.send"]
            )
            if not creds.valid:
                creds.refresh(google.auth.transport.requests.Request())
            return creds
        except Exception as e:
            logger.warning(f"[workspace] Secret Manager lookup failed: {e}. Falling back to ADC.")

    # Local fallback: try ADC — only works if the user completed the Desktop App
    # OAuth flow locally (not gcloud ADC, which is blocked for Gmail in Workspace orgs).
    try:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/gmail.send"])
        if not creds.valid:
            creds.refresh(google.auth.transport.requests.Request())
        # Service accounts won't have a refresh_token — they can't send Gmail
        if not getattr(creds, "refresh_token", None):
            raise ValueError("Credential is a service account and cannot send Gmail.")
        return creds
    except Exception:
        raise RuntimeError(
            "Gmail credentials are not available or are insufficient for Gmail send.\\n"
            "\\n"
            "gcloud application-default credentials are BLOCKED for Gmail in managed\\n"
            "Google Workspace environments — a user OAuth Desktop App client is required.\\n"
            "\\n"
            "To enable Gmail, run:\\n"
            "  bash setup-demo-${suffix}.sh --setup-gmail\\n"
            "\\n"
            "You will need to create an OAuth Desktop App client at:\\n"
            "  https://console.cloud.google.com/apis/credentials"
        )

# ─────────────────────────────────────────────────────────────────────────────
# Gmail
# ─────────────────────────────────────────────────────────────────────────────

def _gmail_send_sync(to: str, subject: str, body: str) -> dict:
    try:
        try:
            creds = _gmail_credentials()
        except RuntimeError as setup_err:
            return {"error": str(setup_err)}
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        msg = MIMEMultipart("alternative")
        msg["To"] = to
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain"))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        result = service.users().messages().send(userId="me", body={"raw": raw}).execute()
        return {"success": True, "message_id": result.get("id"), "to": to, "subject": subject}
    except RuntimeError as e:
        return {"error": str(e)}
    except HttpError as e:
        return {"error": f"Gmail API error: {e}", "to": to}
    except Exception as e:
        return {"error": str(e)}

async def gmail_send(to: str, subject: str, body: str) -> dict:
    """Send a notification email via Gmail on behalf of the authenticated user.

    Use this tool when an anomaly warrants a direct, personal notification to a
    specific individual (e.g. a manager or data owner). Always show the draft to
    the user and get explicit confirmation before calling this tool.

    Args:
        to: Recipient email address (e.g. 'jane.doe@company.com').
        subject: Email subject — concise and action-oriented
                 (e.g. 'Action Required: 40% revenue drop in West region Q3').
        body: Plain-text body. Include: what anomaly was found, which table/metric,
              the magnitude, and a suggested next step.

    Returns:
        dict with 'success' and 'message_id' on success, or 'error' on failure.
    """
    return await anyio.to_thread.run_sync(lambda: _gmail_send_sync(to, subject, body))

# ─────────────────────────────────────────────────────────────────────────────
# Google Chat (Incoming Webhook — no auth required)
# ─────────────────────────────────────────────────────────────────────────────

def _chat_send_sync(message: str) -> dict:
    webhook_url = os.getenv("GOOGLE_CHAT_WEBHOOK_URL", "").strip()
    if not webhook_url:
        return {
            "error": (
                "GOOGLE_CHAT_WEBHOOK_URL is not set. "
                "Add an incoming webhook URL to your .env file."
            )
        }
    import urllib.request, urllib.error
    payload = json.dumps({"text": message}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url, data=payload,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return {"success": True, "response": json.loads(body) if body else {}}
    except urllib.error.HTTPError as e:
        return {"error": f"Chat webhook HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}

async def chat_send_message(message: str) -> dict:
    """Post a message to a Google Chat space via incoming webhook.

    Use this when an anomaly should be broadcast to a team or channel rather than
    a single person. Best for alerts that require group awareness or discussion.
    Always confirm the message with the user before sending.

    Args:
        message: Message text. Supports Chat markdown (*bold*, _italic_, \`\`\`code\`\`\`).
                 Keep under 4000 characters. Good structure:
                 🚨 *Alert title* \\n Summary \\n Affected metric \\n Recommended action.

    Returns:
        dict with 'success': True on success, or 'error' on failure.
    """
    return await anyio.to_thread.run_sync(lambda: _chat_send_sync(message))

# ─────────────────────────────────────────────────────────────────────────────
# Google Sheets
# ─────────────────────────────────────────────────────────────────────────────

def _sheets_create_sync(title: str, headers: list, rows: list) -> dict:
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = _sa_credentials(scopes)
    try:
        sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
        drive  = build("drive",  "v3", credentials=creds, cache_discovery=False)

        # Create spreadsheet
        ss = sheets.spreadsheets().create(body={
            "properties": {"title": title},
            "sheets": [{"properties": {"title": "Anomaly Report"}}],
        }).execute()
        sid = ss["spreadsheetId"]

        # Write data
        values = [headers] + [[str(c) for c in row] for row in rows]
        sheets.spreadsheets().values().update(
            spreadsheetId=sid, range="Anomaly Report!A1",
            valueInputOption="RAW", body={"values": values}
        ).execute()

        # Bold header row
        sheets.spreadsheets().batchUpdate(spreadsheetId=sid, body={"requests": [{
            "repeatCell": {
                "range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1},
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold",
            }
        }]}).execute()

        # Share — anyone with link can view
        drive.permissions().create(
            fileId=sid, body={"type": "anyone", "role": "reader"}
        ).execute()

        url = f"https://docs.google.com/spreadsheets/d/{sid}"
        return {"success": True, "url": url, "spreadsheet_id": sid,
                "title": title, "rows_written": len(rows)}
    except HttpError as e:
        return {"error": f"Sheets API error: {e}"}
    except Exception as e:
        return {"error": str(e)}

async def sheets_create_report(title: str, headers: list, rows: list) -> dict:
    """Create a new Google Sheet documenting anomalies found in BigQuery data.

    Creates a formatted spreadsheet (bold header row), populates it with the
    anomaly rows, and shares it publicly (view-only). Returns a URL the user can
    open immediately. Best used when the number of anomalous records is too large
    to display inline in chat.

    Args:
        title: Spreadsheet title (e.g. 'Anomaly Report — West Region Sales Q3 2024').
        headers: Column headers as strings (e.g. ['Date', 'Region', 'Actual', 'Expected', 'Delta%']).
        rows: Anomaly rows as list-of-lists (top 50 most significant records).
              Example: [['2024-09-01', 'West', 12000, 50000, '-76%']].

    Returns:
        dict with 'success', 'url', and 'rows_written' on success, or 'error'.
    """
    return await anyio.to_thread.run_sync(lambda: _sheets_create_sync(title, headers, rows))

# ─────────────────────────────────────────────────────────────────────────────
# Google Docs
# ─────────────────────────────────────────────────────────────────────────────

def _docs_create_sync(title: str, content: str) -> dict:
    scopes = [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = _sa_credentials(scopes)
    try:
        docs  = build("docs",  "v1", credentials=creds, cache_discovery=False)
        drive = build("drive", "v3", credentials=creds, cache_discovery=False)

        # Create document
        doc = docs.documents().create(body={"title": title}).execute()
        doc_id = doc["documentId"]

        # Insert content
        if content:
            docs.documents().batchUpdate(documentId=doc_id, body={
                "requests": [{"insertText": {"location": {"index": 1}, "text": content}}]
            }).execute()

        # Share — anyone with link can view
        drive.permissions().create(
            fileId=doc_id, body={"type": "anyone", "role": "reader"}
        ).execute()

        url = f"https://docs.google.com/document/d/{doc_id}"
        return {"success": True, "url": url, "document_id": doc_id, "title": title}
    except HttpError as e:
        return {"error": f"Docs API error: {e}"}
    except Exception as e:
        return {"error": str(e)}

async def docs_create_report(title: str, content: str) -> dict:
    """Create a Google Doc containing a full written anomaly analysis report.

    Produces a readable document and shares it publicly (view-only). Best used
    after the quantitative analysis is done and a narrative summary is needed —
    for stakeholder communication or post-mortem documentation.

    Args:
        title: Document title (e.g. 'Inventory Discrepancy Analysis — Nov 2024').
        content: Full report body as plain text. Suggested structure:
                 Executive Summary / Key Findings / Affected Data / Root Cause Hypotheses
                 / Recommended Actions. Aim for 200–500 words.

    Returns:
        dict with 'success' and 'url' on success, or 'error'.
    """
    return await anyio.to_thread.run_sync(lambda: _docs_create_sync(title, content))

# ─────────────────────────────────────────────────────────────────────────────
# Google Slides
# ─────────────────────────────────────────────────────────────────────────────

def _slides_create_sync(title: str, slides: list) -> dict:
    """
    slides: list of dicts with keys:
      - heading (str): slide title / heading text
      - body    (str): bullet-point body text (newline-separated lines)
    """
    scopes = [
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = _sa_credentials(scopes)
    try:
        prs_svc = build("slides", "v1", credentials=creds, cache_discovery=False)
        drv_svc = build("drive",  "v3", credentials=creds, cache_discovery=False)

        # Create a blank presentation
        prs = prs_svc.presentations().create(body={"title": title}).execute()
        prs_id = prs["presentationId"]

        requests = []

        # Delete the default blank slide that Google creates automatically
        default_slide_id = prs["slides"][0]["objectId"]
        requests.append({"deleteObject": {"objectId": default_slide_id}})

        for slide in slides:
            heading = slide.get("heading", "")
            body_text = slide.get("body", "")

            slide_id    = f"slide_{len(requests)}"
            title_id    = f"title_{len(requests)}"
            body_id     = f"body_{len(requests)}"

            # Add slide with TITLE_AND_BODY layout
            requests.append({
                "createSlide": {
                    "objectId": slide_id,
                    "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"},
                    "placeholderIdMappings": [
                        {"layoutPlaceholder": {"type": "TITLE"},       "objectId": title_id},
                        {"layoutPlaceholder": {"type": "BODY"},        "objectId": body_id},
                    ],
                }
            })
            # Set heading text
            requests.append({
                "insertText": {"objectId": title_id, "text": heading}
            })
            # Set body text
            if body_text:
                requests.append({
                    "insertText": {"objectId": body_id, "text": body_text}
                })

        if requests:
            prs_svc.presentations().batchUpdate(
                presentationId=prs_id, body={"requests": requests}
            ).execute()

        # Share — anyone with link can view
        drv_svc.permissions().create(
            fileId=prs_id, body={"type": "anyone", "role": "reader"}
        ).execute()

        url = f"https://docs.google.com/presentation/d/{prs_id}"
        return {"success": True, "url": url, "presentation_id": prs_id,
                "title": title, "slides_created": len(slides)}
    except HttpError as e:
        return {"error": f"Slides API error: {e}"}
    except Exception as e:
        return {"error": str(e)}

async def slides_create_presentation(title: str, slides: list) -> dict:
    """Create a Google Slides presentation from structured slide data.

    Produces a multi-slide deck and shares it publicly (view-only). Best used
    when the user wants a ready-made presentation to share with stakeholders —
    for example, an executive summary of detected anomalies or a data quality
    review deck. Always confirm the slide outline with the user before calling.

    Args:
        title: Presentation title (e.g. 'Q3 2024 Anomaly Review — West Region').
        slides: List of slide dicts. Each dict must have:
            - heading (str): The slide title / heading line.
            - body (str): Body content as plain text; use newlines to separate
                          bullet points (e.g. '• Sales dropped 40%\\n• Affected: 3 stores').
            Example:
            [
              {"heading": "Executive Summary",
               "body": "• 3 anomalies detected in West region\\n• Total revenue impact: -$1.2M"},
              {"heading": "Root Cause Hypotheses",
               "body": "• Possible data pipeline gap\\n• Seasonal adjustment missing"}
            ]

    Returns:
        dict with 'success', 'url', and 'slides_created' on success, or 'error'.
    """
    return await anyio.to_thread.run_sync(lambda: _slides_create_sync(title, slides))

# ─────────────────────────────────────────────────────────────────────────────
# Google Drive — search / list files
# ─────────────────────────────────────────────────────────────────────────────

def _drive_search_sync(query: str, max_results: int) -> dict:
    scopes = ["https://www.googleapis.com/auth/drive.readonly"]
    creds = _sa_credentials(scopes)
    try:
        drv_svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        results = drv_svc.files().list(
            q=query,
            pageSize=max_results,
            fields="files(id, name, mimeType, webViewLink, modifiedTime)",
            orderBy="modifiedTime desc",
        ).execute()
        files = results.get("files", [])
        return {"success": True, "files": files, "count": len(files)}
    except HttpError as e:
        return {"error": f"Drive API error: {e}"}
    except Exception as e:
        return {"error": str(e)}

async def drive_search_files(query: str, max_results: int = 10) -> dict:
    """Search for files in Google Drive using a Drive query string.

    Use this to locate existing reports, sheets, or docs that may already
    contain relevant data before creating new ones. Returns file names, types,
    and direct view links.

    Args:
        query: A Drive API query string. Common examples:
               - \\'name contains "Anomaly Report"\\' — files with that phrase in the name
               - \\'mimeType = "application/vnd.google-apps.spreadsheet"\\' — all Sheets
               - \\'mimeType = "application/vnd.google-apps.document"\\' — all Docs
               - \\'modifiedTime > "2024-01-01T00:00:00"\\'  — recently modified files
               Combine with \\'and\\': \\'name contains "Report" and mimeType = "application/vnd.google-apps.spreadsheet"\\'
        max_results: Maximum number of files to return (default 10, max 50).

    Returns:
        dict with 'success', 'files' (list of {name, mimeType, webViewLink, modifiedTime}),
        and 'count' on success, or 'error'.
    """
    max_results = min(int(max_results), 50)
    return await anyio.to_thread.run_sync(lambda: _drive_search_sync(query, max_results))

# ─────────────────────────────────────────────────────────────────────────────
# Tool registry
# ─────────────────────────────────────────────────────────────────────────────
WORKSPACE_TOOLS = [
    gmail_send,
    chat_send_message,
    sheets_create_report,
    docs_create_report,
    slides_create_presentation,
    drive_search_files,
]
__WS_EOF__
` : ''}

cat <<__AGENT_EOF__ > adk_agent/mcp_app/agent.py
import os

# =============================================================================
# Environment Configuration
# Force project ID and location BEFORE importing ADK/genai
# =============================================================================
os.environ["GOOGLE_CLOUD_PROJECT"] = "$PROJECT_ID"
# Force global location for Gemini 3 models
os.environ["GOOGLE_CLOUD_LOCATION"] = "global"

import dotenv
dotenv.load_dotenv()

from . import tools
${useGoogleWorkspace ? 'from . import workspace_tools' : ''}
from google.adk.agents import LlmAgent
from google.adk.models import Gemini
from google.genai import types
from google.adk.apps.app import App, EventsCompactionConfig
from google.adk.plugins import ReflectAndRetryToolPlugin, LoggingPlugin
from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_response import LlmResponse

PROJECT_ID = "$PROJECT_ID"

maps_toolset = tools.get_maps_mcp_toolset()
bigquery_toolset = tools.get_bigquery_mcp_toolset()
${useGoogleWorkspace ? 'workspace_tool_list = workspace_tools.WORKSPACE_TOOLS' : ''}

# =============================================================================
# AGENT CONFIGURATION (Zero-Formatting Instruction Pattern)
# =============================================================================
# We intentionally avoid Python f-strings or .format() here to prevent crashes
# when the generated System Instruction contains literal curly braces {}.
# =============================================================================

base_instruction = """
Help the user answer questions by strategically combining insights from BigQuery and Google Maps:

1. **BigQuery Toolset**: Access data in the [PROJECT_ID].[DATASET_ID] dataset.
   - Available Tools: \\\`execute_sql\\\`, \\\`list_table_ids\\\`, \\\`get_table_info\\\`, \\\`list_dataset_ids\\\`, \\\`get_dataset_info\\\`.
   - DATASET ISOLATION (CRITICAL): You MUST ONLY access the \\\`[DATASET_ID]\\\` dataset. DO NOT use \\\`list_dataset_ids\\\` to discover other datasets. DO NOT query any dataset other than \\\`[DATASET_ID]\\\` (except public datasets when explicitly instructed). If a user asks about data not in \\\`[DATASET_ID]\\\`, inform them that only this dataset is available for this demo.
[PUBLIC_DATASET_INFO]

[GENERATED_SYSTEM_INSTRUCTION]

- REFERENCE DATE: The current date for this demo is [REFERENCE_DATE]. Use this for absolute time references (e.g., 'today', 'last month').

2. **Maps Toolset**: Real-world location analysis.
   - Available Tools: \\\`compute_routes\\\`, \\\`get_place\\\`, \\\`search_places\\\`, \\\`geocode\\\`, \\\`reverse_geocode\\\`.
   - IMPORTANT: There is NO weather tool. Do not hallucinate or attempt to use weather services.

${useGoogleWorkspace ? `3. **Google Workspace Tools**: Act on findings from BigQuery by notifying people and documenting anomalies using Google Workspace.

   **Communication**
   - \\\`gmail_send(to, subject, body)\\\` — Email a specific person about a finding. Use for direct, personal alerts to data owners or managers.
   - \\\`chat_send_message(message)\\\` — Post an alert to the configured Google Chat space. Use for team-wide notifications.

   **Document Creation (Google Drive)**
   - \\\`sheets_create_report(title, headers, rows)\\\` — Create a formatted Google Sheet from anomaly rows. Best when there are many records to share. Returns a public view URL.
   - \\\`docs_create_report(title, content)\\\` — Write a narrative analysis document. Best for stakeholder summaries or post-mortem reports. Returns a public view URL.
   - \\\`slides_create_presentation(title, slides)\\\` — Build a multi-slide Google Slides deck. Best when the user needs a ready-made presentation (e.g. executive briefing, QBR slide). Each slide has a \\\`heading\\\` and a \\\`body\\\` (newline-separated bullet points). Returns a public view URL.
   - \\\`drive_search_files(query, max_results)\\\` — Search for existing files in Google Drive by name, type, or modification date. Use before creating new documents to check if a relevant file already exists.

   WORKFLOW — When you detect an anomaly in BigQuery data, follow this pattern:
     1. Quantify it — run SQL to measure the magnitude (%, absolute delta, affected records).
     2. Surface it — present a clear summary to the user: what is wrong, how bad it is, which data supports it.
     3. Propose action — suggest the right Workspace action: email a person / post to Chat / create a Sheet, Doc, or Slides deck. Let the user choose.
     4. Confirm — show the exact content (email draft, message text, slide outline, sheet columns) and wait for explicit user approval before calling the tool.
     5. Execute — call the tool and report back the result (include any returned URLs as clickable links).

   SAFETY RULES:
   - NEVER call \\\`gmail_send\\\` or \\\`chat_send_message\\\` without the user's explicit "yes" in that turn.
   - Always show what you will send or create BEFORE calling any tool.
   - For \\\`sheets_create_report\\\`, limit rows to the top 50 most significant anomalies.
   - For \\\`slides_create_presentation\\\`, keep decks concise: 5–10 slides maximum unless the user requests more.
   - If a Workspace tool returns an \\\`error\\\` key, report the error clearly and do not retry silently.` : ''}

---------------------------------------------------
CRITICAL OPERATIONAL RULES:
- VISUAL ASSETS & IMAGES:
    * Your output MUST NOT contain any inline images.
    * You are forbidden from using Markdown's ![alt text](url) syntax.
    * If you need to reference an image from tools or guidelines, describe it textually and provide the viewing link as a standard hyperlink.
    * Correct Usage: The official logo is a green apple. Data from: [Cymbal Brand Guidelines](https://storage.googleapis.com/...)
    * Incorrect Usage: ![Cymbal Logo](https://storage.googleapis.com/...)

- DATA DISCOVERY & ACCURACY (HIGHEST PRIORITY): 
    * ADAPTIVE DISCOVERY: Use \\\`get_table_info\\\` only when necessary to confirm schemas for a specific query. 
    * DO NOT ASSUME column names (e.g., 'region', 'category', 'prefecture') exist without checking. Hallucinating columns causes fatal errors.
    * AUTONOMOUS ERROR RECOVERY: If a SQL query fails, DO NOT ask the user for help immediately. Instead, output a status message explaining the error (e.g. "⚠️ Query failed due to column mismatch. Re-checking schema..."), then re-run \\\`get_table_info\\\` to verify schema, explore values with \\\`SELECT DISTINCT\\\`, and fix the query yourself. Be relentless in finding the correct data.
    * VALUE EXPLORATION: For unfamiliar columns, run \\\`SELECT DISTINCT column LIMIT 10\\\` to identify valid values.
- EXECUTION FLOW: 
    * REACTIVE BEHAVIOR: Always wait for a specific user request or question before starting data analysis or tool execution. Respond to greetings with a friendly message and a brief offer of help.
    * MULTI-STEP PLANNING: For complex requests, summarize your planned steps in 1-2 sentences before starting the first tool execution. This keeps the user informed of your reasoning path.
    * RANGE QUERIES & DISCOVERY (STRICT RULE): If you need to analyze a time range (e.g., 'first two weeks') or discover unique values for a column, you MUST query ONLY THE SMALLEST PRACTICAL SUBSET (e.g., first day or LIMIT 10) first to verify data density and schema. DO NOT 'gulp' large ranges or entire columns in a single response, as this crashes the data pipe.
    * GULP PREVENTION (MANDATORY): EVERY \\\`execute_sql\\\` query MUST include a \\\`LIMIT 100\\\` or smaller unless you are explicitly counting rows. Never attempt to retrieve thousands of rows at once.
    * SELECT ONLY: Only SELECT statements are supported. Do not attempt INSERT, UPDATE, or DELETE.
    * SEQUENTIAL EXECUTION (MANDATORY): You MUST call exactly ONE tool per response and wait for its output. Proposing multiple tools (parallelism) is COMPLETELY FORBIDDEN and triggers fatal session termination by the infrastructure. Slow, steady progress is the only way to succeed.
- GEOSPATIAL CONTEXT: Use specific location data from BigQuery (city, state, etc.) in Maps tool calls to ensure accuracy.
- PROGRESS UPDATES (MANDATORY): You MUST output a brief status message with an emoji BEFORE every single tool call (e.g., "📊 Checking schema...", "🔍 Running SQL...", "🗺️ Calculating routes..."). This is critical for the user to see your progress in the UI. Even if you are repeating a step, report it.
- PUBLIC DATASET ACCESS (CRITICAL):
    * The projectId argument in ALL BigQuery tool calls MUST ALWAYS be YOUR project ID ([PROJECT_ID]). NEVER use "bigquery-public-data" as projectId.
    * Access public tables ONLY via \\\`execute_sql\\\` using fully qualified names (e.g., \\\`bigquery-public-data.google_trends.top_terms\\\`).
---------------------------------------------------
"""

public_info = "- Additional Dataset: Use [PUBLIC_DATASET_ID] for context." if "[PUBLIC_DATASET_ID]" else ""

# Embedding instruction directly (Reverted from separate file approach)
gen_instruction = r"""
${rawInstruction}
"""

instruction = base_instruction\
    .replace("[PROJECT_ID]", PROJECT_ID)\
    .replace("[DATASET_ID]", "${datasetId}")\
    .replace("[REFERENCE_DATE]", "${referenceDate}")\
    .replace("[PUBLIC_DATASET_INFO]", public_info.replace("[PUBLIC_DATASET_ID]", "${publicDatasetId || ''}"))\
    .replace("[GENERATED_SYSTEM_INSTRUCTION]", gen_instruction)

# Configure the model with automatic retries for 429/5xx errors
gemini_model = Gemini(
    model="gemini-3.1-pro-preview",
    retry_options=types.HttpRetryOptions(
        attempts=8,              # Increase attempts to handle higher load
        initial_delay=2.0,       # Initial backoff delay
        max_delay=60.0,          # Cap wait time at 60s
        exp_base=2.0,            # Exponential backoff
        http_status_codes=[429]  # Explicitly retry on Resource Exhausted
    )
)

async def inject_image_callback(callback_context: CallbackContext, llm_response: LlmResponse) -> LlmResponse | None:
    """Injects the generated image into the final LLM response."""
    if llm_response and llm_response.content and llm_response.content.parts:
        for part in llm_response.content.parts:
            if part.function_call:
                return llm_response
        
    image_bytes = callback_context.session.state.pop('pending_generated_image', None)
    
    if image_bytes and llm_response and llm_response.content:
        llm_response.content.parts.append(
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
        )
        
    return llm_response

root_agent = LlmAgent(
    model=gemini_model,
    name='root_agent',
    instruction=instruction,
    tools=[maps_toolset, bigquery_toolset, ${useGoogleWorkspace ? '*workspace_tool_list, ' : ''}tools.generate_image],
    after_model_callback=inject_image_callback,
    generate_content_config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(
            include_thoughts=True
        )
    )
)

app = App(
    name="mcp_app",
    root_agent=root_agent,
    plugins=[
        ReflectAndRetryToolPlugin(), 
        LoggingPlugin()
    ],
    events_compaction_config=EventsCompactionConfig(
        compaction_interval=20, 
        overlap_size=3
    )
)

__all__ = ["root_agent", "app"]
__AGENT_EOF__


# --- 8. Agent Engine & Gemini Enterprise Infrastructure ---
if [ "$DEPLOY_CHOICE" = "3" ]; then
  # Automate 'agent-starter-pack enhance'
  echo ""
  echo "🔧 Initializing Agent Engine infrastructure..."
  # We MUST be in the adk_agent directory for enhance to handle mcp_app correctly
  cd adk_agent
  export UV_LINK_MODE=copy
  printf '\n\n\n\n\n\n\n' | uvx --no-cache agent-starter-pack enhance
  
  # Apply naming fixes (Robust regex for different quote styles and separators)
  echo "🔧 Applying project name customizations..."
  rm -f .resource_name
  # Replace name in adk_agent/pyproject.toml (Tool normalizes adk_agent -> adk-agent)
  perl -pi -e "s/name *= *[\\\"']mcp[-_]agent[\\\"']/name = \\\"${dirName}\\\"/" pyproject.toml
  # Constrain python version to avoid uv resolution errors on python 3.13
  if grep -q "^requires-python" pyproject.toml; then
    perl -pi -e 's/^requires-python\\s*=.*/requires-python = ">=3.10,<3.13"/' pyproject.toml
  else
    perl -pi -e 's/(\\[project\\])/$1\\nrequires-python = ">=3.10,<3.13"/' pyproject.toml
  fi
  # agent-starter-pack enhance writes [tool.uv] environments = ["sys_platform == 'linux'"].
  # This causes 'uv export' to fail on macOS ("not compatible with lockfile's supported environments").
  # Fix: remove the environments constraint so uv resolves for the current platform.
  # The generated requirements.txt is then installed inside a linux Docker container, which works fine.
  if grep -q "sys_platform" pyproject.toml; then
    perl -0pi -e 's/\nenvironments\s*=\s*\[[^\]]*\]//g' pyproject.toml
    echo "Patched pyproject.toml: removed sys_platform environments constraint for cross-platform compatibility."
  fi
  if ! grep -q "\\[tool\\.uv\\]" pyproject.toml; then
    printf '\n[tool.uv]\n' >> pyproject.toml
  fi
  # Replace default name in deploy.py
  perl -pi -e "s/default *= *[\\\"']adk[-_]agent[\\\"']/default=\\\"${dirName}\\\"/" mcp_app/app_utils/deploy.py 2>/dev/null || true
  

  
  cd ..
fi

# --- 9. Final Launch & Tips ---
if [ "$DEPLOY_CHOICE" = "3" ]; then
  echo ""
  echo "========================================================="
  echo "🚀 DEPLOYING TO GEMINI ENTERPRISE"
  echo "========================================================="
  
  echo "🤖 Step 1/2: Deploying to Vertex AI Agent Engine..."
  cd adk_agent
  
  # Prevent 'No space left on device' errors in environments like Cloud Shell
  if command -v uv >/dev/null 2>&1; then
    uv cache clean || true
  fi
  export UV_NO_CACHE=1
  
  make deploy
  
  echo ""
  echo "🤖 Step 2/2: Registering Agent to Gemini Enterprise..."
  # Count apps across all common locations
  TOKEN=$(gcloud auth print-access-token)
  APP_COUNT=0
  for LOC in "global" "us" "eu"; do
    JSON=$(curl -s -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT_ID" \
        "https://discoveryengine.googleapis.com/v1alpha/projects/$PROJECT_ID/locations/$LOC/collections/default_collection/engines")
    COUNT=$(echo "$JSON" | jq -r ".engines | length" 2>/dev/null || echo "0")
    APP_COUNT=$((APP_COUNT + COUNT))
  done
  
  if [ "$APP_COUNT" = "1" ]; then
    echo "✅ Found exactly one Gemini Enterprise app. Automating registration..."
    # Y (Agent ID) -> Y (Project ID) -> Default (App Selection) -> Y (Use this app?) -> Any subsequent defaults (yes "")
    (printf "Y\\nY\\n\\nY\\n"; yes "") | make register-gemini-enterprise
  else
    if [ "$APP_COUNT" = "0" ]; then
      echo "⚠️ No Gemini Enterprise apps found in 'global', 'us', or 'eu'. You might need to create one first."
    else
      echo "💡 Found $APP_COUNT apps across regions. Please select one manually:"
    fi
    # Fallback: Automated defaults (Y, Y) + interactive app selection
    (printf "Y\\nY\\n"; cat) | make register-gemini-enterprise
  fi

  cd ..
  
  clear
  echo "========================================================="
  echo "🎉 Gemini Enterprise Deployment & Registration Complete!"
  echo "========================================================="
  echo ""
  echo "📂 Project directory: ${dirName}"
  echo ""
  echo "🔗 View in Console:"
  echo "   https://console.cloud.google.com/gemini-enterprise/overview?project=$PROJECT_ID"
  echo ""
  echo "========================================================="
  echo "💡 TIPS:"
  echo "   • Your agent is now available in your Gemini Enterprise organization."
  echo "   • To CLEANUP:        bash setup-${dirName}.sh --cleanup"
  echo "========================================================="
  exit 0
fi

if [ "$DEPLOY_CHOICE" = "2" ]; then
  echo "🚀 Deploying to Cloud Run (this will take 2-3 minutes)..."
  # Note: --set-env-vars is used to inject the runtime configuration
  # Deploy to Cloud Run (Unauthenticated / IAP-less)
  SERVICE_NAME="${dirName}"
  gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --ingress all \
    --service-account "\${COMPUTE_SA}" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,MAPS_API_KEY=$API_KEY" \
    --quiet

  # Get the URL and append the auto-selection parameter for mcp_app
  BASE_URL=$(gcloud run services describe "$SERVICE_NAME" --region us-central1 --format='value(status.url)')
  SERVICE_URL="\${BASE_URL}/dev-ui/?app=mcp_app"
  
  clear
  echo "========================================================="
  echo "🎉 Cloud Run Deployment Complete!"
  echo "========================================================="
  echo ""
  echo "📂 Project directory: ${dirName}"
  echo "🌐 Public URL: \$SERVICE_URL"
  echo ""
  echo "========================================================="
  echo "💡 TIPS:"
  echo "   • The agent is now live at the URL above."
  echo "   • To CLEANUP:        bash setup-${dirName}.sh --cleanup"
  echo "========================================================="
  exit 0
fi

# --- Local Launch Logic ---
is_port_busy() {
  local port=\$1
  # Method 1: lsof (Standard on Mac)
  if command -v lsof >/dev/null 2>&1; then
    lsof -Pi :\$port -sTCP:LISTEN -t >/dev/null 2>&1 && return 0
  fi
  # Method 2: Python socket (Reliable fallback)
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', \$port))" >/dev/null 2>&1 || return 0
  fi
  return 1
}

find_free_port() {
  local port=\$1
  while is_port_busy \$port; do
    port=\$((port + 1))
  done
  echo "\$port"
}

START_PORT=8000
if [ "$CLOUD_SHELL" = "true" ]; then START_PORT=8080; fi
PORT=$(find_free_port \$START_PORT)

clear
echo "========================================================="
echo "🎉 Local Setup Complete!"
echo "========================================================="
echo ""
echo "📂 Project directory: ${dirName}"
echo "🚀 Launching the Agent UI on port \$PORT..."
echo "   (Pre-configured for project: \$PROJECT_ID)"
if [ "$CLOUD_SHELL" = "true" ]; then
  echo ""
  echo "💡 CLOUD SHELL TIP:"
  echo "   Use the 'Web Preview' button (top right) and select 'Change port' to \$PORT."
fi
echo ""
echo "========================================================="
echo "💡 TIPS:"
echo "   • To STOP the UI:    Press Ctrl+C"
echo "   • To RESTART the UI: Run the following commands:"
echo ""
echo "     cd ~/${dirName}/adk_agent"
echo "     ../.venv/bin/adk web --port \$PORT --allow_origins=\"*\""
echo ""
echo "   • To CLEANUP:        bash setup-${dirName}.sh --cleanup"
echo ""
echo "========================================================="
echo ""

cd adk_agent
../.venv/bin/adk web --port \$PORT --allow_origins="*"
`;
}

// ===========================================
// Vertex AI & Utilities
// ===========================================

function callVertexAIWithRetry(prompt) { return executeWithRetry(() => callVertexAI(prompt)); }

function callVertexAI(prompt) {
  let location = CONFIG.LOCATION || 'global';
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL}:generateContent`;
  
  const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 65535 } };
  const response = UrlFetchApp.fetch(url, { method: 'POST', contentType: 'application/json', headers: { 'Authorization': 'Bearer ' + getVertexAccessToken_() }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error(`AI Error: ${response.getContentText()}`);
  return JSON.parse(response.getContentText()).candidates[0].content.parts[0].text;
}

/**
 * Calls Vertex AI with Google Search grounding enabled.
 * Used for discovering real BigQuery public dataset IDs.
 */
function callVertexAIWithSearch(prompt) {
  let location = CONFIG.LOCATION || 'global';
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL}:generateContent`;
  
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
  };
  const response = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + getVertexAccessToken_() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error(`AI Search Error: ${response.getContentText()}`);
  return JSON.parse(response.getContentText()).candidates[0].content.parts[0].text;
}



/**
 * Returns a Vertex AI access token.
 * Prefers VERTEX_SERVICE_ACCOUNT_JSON Script Property (recommended for portability —
 * set this to the full contents of a GCP service account key JSON with Vertex AI User role).
 * Falls back to ScriptApp.getOAuthToken() for quick local testing without a SA key.
 */
function getVertexAccessToken_() {
  var saJson = SCRIPT_PROPS.getProperty('VERTEX_SERVICE_ACCOUNT_JSON');
  if (saJson) {
    var now = Date.now();
    if (_vertexSaTokenCache.token && now < _vertexSaTokenCache.expMs) {
      return _vertexSaTokenCache.token;
    }
    var tok = exchangeServiceAccountForToken_(saJson);
    _vertexSaTokenCache = { token: tok, expMs: now + 50 * 60 * 1000 };
    return tok;
  }
  return ScriptApp.getOAuthToken();
}

/**
 * Exchanges a GCP service account key JSON for a cloud-platform OAuth access token.
 * Builds and signs a JWT (RS256), then POSTs to oauth2.googleapis.com/token.
 * @param {string} saJson - Full contents of a GCP service account key JSON file.
 * @returns {string} access_token
 */
function exchangeServiceAccountForToken_(saJson) {
  var trimmed = (saJson || '').trim();
  if (trimmed.charCodeAt(0) === 0xfeff) trimmed = trimmed.substring(1).trim();
  if (!trimmed || trimmed.indexOf('{') !== 0) {
    throw new Error('VERTEX_SERVICE_ACCOUNT_JSON must be the full key JSON starting with {. Re-paste the entire JSON file from GCP.');
  }
  var cred;
  try { cred = JSON.parse(trimmed); } catch (e) {
    throw new Error('VERTEX_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
  }
  if (!cred.private_key || !cred.client_email) {
    throw new Error('VERTEX_SERVICE_ACCOUNT_JSON must include client_email and private_key.');
  }
  var privateKey = cred.private_key.replace(/\n/g, '\n');
  var now = Math.floor(Date.now() / 1000);
  var header = base64UrlEncode_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = base64UrlEncode_(JSON.stringify({
    iss: cred.client_email,
    sub: cred.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  var toSign = header + '.' + claim;
  var sig = base64UrlEncode_(Utilities.computeRsaSha256Signature(toSign, privateKey));
  var jwt = toSign + '.' + sig;

  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Service account token exchange failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
  }
  var parsed = JSON.parse(resp.getContentText());
  if (!parsed.access_token) throw new Error('Service account response missing access_token: ' + resp.getContentText());
  return parsed.access_token;
}

/**
 * Base64url encodes a string or byte array (no padding).
 */
function base64UrlEncode_(input) {
  var bytes = typeof input === 'string' ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function executeWithRetry(fn) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try { return fn(); } catch (error) { lastError = error; Utilities.sleep(CONFIG.RETRY_DELAY_MS * attempt); }
  }
  throw lastError;
}




/**
 * Fetches recent commit history from GitHub API as update logs.
 * Fallbacks to static CONFIG.UPDATE_LOG if API fails.
 */
function fetchGitLogs() {
  const repoUrl = 'https://api.github.com/repos/ryotat7/ge-demo-generator/commits';
  try {
    const response = UrlFetchApp.fetch(repoUrl + '?per_page=10', {
      muteHttpExceptions: true,
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    
    if (response.getResponseCode() === 200) {
      const commits = JSON.parse(response.getContentText());
      return commits.map(c => {
        const msg = c.commit.message.split('\n')[0];
        const versionMatch = msg.match(/v\d+\.\d+\.\d+/);
        const version = versionMatch ? versionMatch[0] : c.sha.substring(0, 7);
        
        return {
          version: version,
          date: c.commit.author.date.split('T')[0],
          note: msg
        };
      });
    }
  } catch (e) {
    // console.log('GitHub API Error:', e.message);
  }
  return CONFIG.UPDATE_LOG; 
}

function updateSystemInstruction(setupScript, newInstruction) {
  const escaped = newInstruction.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/\n/g, '\\n');
  return setupScript.replace(/(1\.\s+\*\*BigQuery toolset:\*\*.*?\n)([\s\S]*?)(\n\s+2\.\s+\*\*Maps Toolset:\*\*)/, `$1${escaped}$3`);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Generates a text-based PDF from content using DocumentApp.
 * @param {string} content - The content to written into the PDF.
 * @param {string} fileName - The name of the generated PDF file.
 * @returns {object} { success: boolean, base64: string, error?: string }
 */
function generatePdfFromServer(content, fileName) {
  try {
    const doc = DocumentApp.create('Temp PDF Generation');
    const body = doc.getBody();
    
    function applyBold(element, text) {
      if (!text) return;
      const parts = text.split('**');
      if (parts.length <= 1) return;
      
      let newText = '';
      const boldRanges = [];
      
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) { // It's a bold part
          const start = newText.length;
          newText += parts[i];
          const end = newText.length - 1;
          boldRanges.push({start, end});
        } else {
          newText += parts[i];
        }
      }
      
      element.setText(newText);
      const textElement = element.editAsText();
      boldRanges.forEach(range => {
        textElement.setBold(range.start, range.end, true);
      });
    }
    
    const lines = content.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) {
        body.appendParagraph('');
        return;
      }
      
      if (trimmed.startsWith('# ')) {
        const p = body.appendParagraph(trimmed.substring(2)).setHeading(DocumentApp.ParagraphHeading.HEADING1);
        applyBold(p, trimmed.substring(2));
      } else if (trimmed.startsWith('## ')) {
        const p = body.appendParagraph(trimmed.substring(3)).setHeading(DocumentApp.ParagraphHeading.HEADING2);
        applyBold(p, trimmed.substring(3));
      } else if (trimmed.startsWith('### ')) {
        const p = body.appendParagraph(trimmed.substring(4)).setHeading(DocumentApp.ParagraphHeading.HEADING3);
        applyBold(p, trimmed.substring(4));
      } else if (trimmed.startsWith('- ')) {
        const li = body.appendListItem(trimmed.substring(2));
        applyBold(li, trimmed.substring(2));
      } else if (trimmed.startsWith('[CHART:')) {
        const match = trimmed.match(/\[CHART:\s*(BAR|PIE|LINE)?,?\s*([^,\]]+),\s*([^\]]+)\]/i);
        if (match) {
          const type = (match[1] || 'BAR').toUpperCase();
          const title = match[2].trim();
          const dataStr = match[3].trim();
          const pairs = dataStr.split(',').map(p => p.trim());
          
          const dataTable = Charts.newDataTable();
          dataTable.addColumn(Charts.ColumnType.STRING, "Item");
          dataTable.addColumn(Charts.ColumnType.NUMBER, "Value");
          
          pairs.forEach(p => {
             const parts = p.split('=');
             if (parts.length === 2) {
               dataTable.addRow([parts[0].trim(), parseFloat(parts[1].trim()) || 0]);
             }
          });
          
          let builder;
          if (type === 'PIE') {
             builder = Charts.newPieChart();
          } else if (type === 'LINE') {
             builder = Charts.newLineChart();
          } else {
             builder = Charts.newBarChart();
          }
          
          const chart = builder
               .setDataTable(dataTable.build())
               .setTitle(title)
               .setDimensions(600, 300)
               .build();
          
          const imageBlob = chart.getAs('image/png');
          body.appendImage(imageBlob);
        } else {
           const p = body.appendParagraph(trimmed);
           applyBold(p, trimmed);
        }
      } else {
        const p = body.appendParagraph(trimmed);
        applyBold(p, trimmed);
      }
    });
    
    doc.saveAndClose();
    
    const pdfBlob = doc.getAs('application/pdf');
    pdfBlob.setName(fileName);
    
    const base64 = Utilities.base64Encode(pdfBlob.getBytes());
    
    DriveApp.getFileById(doc.getId()).setTrashed(true);
    
    return { success: true, base64: base64 };
  } catch (e) {
    console.error('PDF generation failed:', e.message);
    return { success: false, error: e.message };
  }
}

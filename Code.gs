/**
 * AWT Demo Engine - Backend (Apps Script)
 *
 * Dynamically generates a portable AI agent demo environment using Vertex AI,
 * optional Drive demo kit provisioning, optional Workspace seeds in setup.sh,
 * and BigQuery + Maps MCP servers in the generated runtime.
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
  RETRY_DELAY_MS: 1000
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

    var durMsRaw =
      logEntry.durationMs !== undefined && logEntry.durationMs !== null ? Number(logEntry.durationMs) : '';
    var outLang = logEntry.outputLanguage !== undefined ? String(logEntry.outputLanguage) : '';
    var demoLen = logEntry.demoLength !== undefined ? String(logEntry.demoLength) : '';
    var workflow = logEntry.workflowArchetype !== undefined ? String(logEntry.workflowArchetype) : '';
    var wsTools =
      logEntry.workspaceToolsEnabled !== undefined
        ? logEntry.workspaceToolsEnabled
          ? 'Yes'
          : 'No'
        : '';
    var ua =
      logEntry.clientUserAgent !== undefined && logEntry.clientUserAgent !== null
        ? String(logEntry.clientUserAgent)
        : '';
    var clientIp =
      logEntry.clientIp !== undefined && logEntry.clientIp !== null ? String(logEntry.clientIp) : '';

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
      logEntry.errorClass || 'N/A',
      outLang,
      demoLen,
      workflow,
      wsTools,
      durMsRaw,
      ua,
      clientIp
    ];

    // If empty sheet, write header (existing deployments may add these columns manually if upgrading)
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Timestamp',
        'User Email',
        'Dataset ID',
        'Status',
        'Duration',
        'Req. Rows',
        'Req. Tables',
        'Public Dataset',
        'Table Names',
        'Error Class',
        'Output Lang',
        'Demo Length',
        'Workflow Archetype',
        'Workspace Tools',
        'Duration (ms)',
        'User Agent',
        'Client IP (reported)'
      ]);
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
 * Flattens generation options and optional clientMeta for Usage_Logs columns.
 * Client IP is browser-reported (not Apps Script server IP).
 */
function buildUsageLogExtras_(options) {
  options = options || {};
  var meta = options.clientMeta || {};
  return {
    outputLanguage: options.outputLanguage != null ? String(options.outputLanguage) : 'auto',
    demoLength: options.demoLength != null ? String(options.demoLength) : '',
    workflowArchetype: options.workflowArchetype != null ? String(options.workflowArchetype) : '',
    workspaceToolsEnabled: !!options.useGoogleWorkspace,
    clientUserAgent: meta.userAgent != null ? String(meta.userAgent) : '',
    clientIp: meta.clientIp != null ? String(meta.clientIp) : ''
  };
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
    useGoogleWorkspace: false,
    /** `auto` = infer narrator language from business problem; otherwise BCP-47 style code from UI (see PlanningPrompt.gs). */
    outputLanguage: 'auto'
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
    appliedFactors: null,
    demoGuideDocUrl: null,
    demoDriveFolderUrl: null
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
    result.demoGuideStoryboard = planResult.demoGuideStoryboard || {};
    result.demoGuideMarkdown = planResult.demoGuideMarkdown || '';
    result.workspaceSeedData = planResult.workspaceSeedData || {};
    result.externalFiles = planResult.externalFiles || [];
    result.appliedFactors = planResult.appliedFactors || {};

    let demoGuideDocUrl = '';
    let demoDriveFolderUrl = '';
    try {
      // Always provision the Drive kit when generation succeeds so the UI gets demo guide + folder URLs.
      // (Markdown may be empty briefly if the planner returns storyboard-only; external files still need a folder.)
      var asmDocs = buildDemoGuideDocAssembly_(planResult);
      var kitDocs = provisionDemoDriveKit_(
        dirName,
        asmDocs.storyboard || {},
        asmDocs.narratorMarkdown || '',
        planResult.externalFiles || [],
        'Demo Guide & Script — ' + dirName
      );
      if (kitDocs) {
        if (kitDocs.demoGuideDocUrl) demoGuideDocUrl = kitDocs.demoGuideDocUrl;
        if (kitDocs.demoDriveFolderUrl) demoDriveFolderUrl = kitDocs.demoDriveFolderUrl;
        if (!kitDocs.success && kitDocs.error) console.error('[DemoDriveKit]', kitDocs.error);
      }
    } catch (docErr) {
      console.error('[DemoDriveKit]', docErr.message);
    }
    result.demoGuideDocUrl = demoGuideDocUrl || null;
    result.demoDriveFolderUrl = demoDriveFolderUrl || null;

    result.setupScript = generateSetupScript({
      datasetId: datasetId,
      systemInstruction: planResult.systemInstruction,
      referenceDate: planResult.referenceDate,
      publicDatasetId: planResult.publicDatasetId,
      suffix: suffix,
      dirName: dirName,
      tables: planResult.tables,
      userGoal: userGoal,
      useGoogleWorkspace: options.useGoogleWorkspace,
      workspaceSeedData: planResult.workspaceSeedData || {},
      demoGuideDocUrl: demoGuideDocUrl,
      demoDriveFolderUrl: demoDriveFolderUrl
    });
    result.steps.push({ step: 4, status: 'completed', message: 'Generation complete' });
    
    result.success = true;
    
    
    // Save to telemetry and log to sheet
    const durationMs = Date.now() - startTime;
    const telemetry = Object.assign(
      {
        datasetId: datasetId,
        status: 'Success',
        durationMs: durationMs,
        rowCount: options.rowCount,
        tableCount: options.tableCount,
        publicDatasetFlag: options.usePublicDataset,
        tableNames: result.rawTables ? result.rawTables.map(t => t.tableName).join(', ') : 'N/A',
        errorClass: null
      },
      buildUsageLogExtras_(options)
    );

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
    const failureTelemetry = Object.assign(
      {
        datasetId: result.datasetId || 'Unknown',
        status: 'Failure',
        durationMs: durationMs,
        rowCount: options.rowCount,
        tableCount: options.tableCount,
        publicDatasetFlag: options.usePublicDataset,
        tableNames: result.rawTables ? result.rawTables.map(t => t.tableName).join(', ') : 'N/A',
        errorClass: error.message
      },
      buildUsageLogExtras_(options)
    );
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

  const planningExtras = normalizePlanningPromptOutputs(parsed);

  return {
    tables: parsed.tables,
    systemInstruction: parsed.systemInstruction,
    referenceDate: parsed.referenceDate || '2023-11-01',
    publicDatasetId: parsed.publicDatasetId || options.publicDatasetId,
    oneSentenceSummary: parsed.oneSentenceSummary || null,
    demoGuide: planningExtras.demoGuideForUi,
    demoGuideStoryboard: planningExtras.demoGuideStoryboard,
    demoGuideMarkdown: planningExtras.demoGuideMarkdown,
    workspaceSeedData: planningExtras.workspaceSeedData,
    externalFiles: parsed.externalFiles || [],
    appliedFactors: parsed.appliedFactors || null,
    dataPreview: dataPreview
  };
}

/**
 * Maps planning JSON keys onto fields expected by the web UI and doc pipeline.
 */
function normalizePlanningPromptOutputs(parsed) {
  const rawDg = parsed.demoGuide;
  let demoGuideMarkdown = '';
  if (typeof rawDg === 'string') {
    demoGuideMarkdown = rawDg;
  } else if (Array.isArray(rawDg) && rawDg.length && typeof rawDg[0] === 'string') {
    demoGuideMarkdown = rawDg.join('\n\n---\n\n');
  }

  var safeGuide = normalizeStoryboardGuide_(
    rawDg && typeof rawDg === 'object' && !Array.isArray(rawDg) ? rawDg : null
  );

  let demoGuideForUi = [];
  if (parsed.scenarioPrompts && Array.isArray(parsed.scenarioPrompts) && parsed.scenarioPrompts.length) {
    demoGuideForUi = parsed.scenarioPrompts;
  }

  let ws = parsed.workspaceSeedData;
  if (ws !== null && ws !== undefined && typeof ws !== 'object') {
    ws = {};
  }

  return {
    demoGuideMarkdown: demoGuideMarkdown,
    demoGuideStoryboard: safeGuide,
    workspaceSeedData: ws || {},
    demoGuideForUi: demoGuideForUi
  };
}

function safeString_(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeStoryboardGuide_(rawGuide) {
  var fallback = {
    demoTitle: 'Generated Demo',
    storyboardTitle: 'Storyboard',
    intro: '',
    scenes: []
  };

  if (!rawGuide || typeof rawGuide !== 'object' || Array.isArray(rawGuide)) return fallback;

  var guide = {
    demoTitle: safeString_(rawGuide.demoTitle) || fallback.demoTitle,
    storyboardTitle: safeString_(rawGuide.storyboardTitle) || fallback.storyboardTitle,
    intro: safeString_(rawGuide.intro),
    scenes: []
  };

  var scenes = Array.isArray(rawGuide.scenes) ? rawGuide.scenes : [];
  for (var i = 0; i < scenes.length; i++) {
    var scene = scenes[i];
    if (!scene || typeof scene !== 'object') continue;
    guide.scenes.push({
      sceneTitle: safeString_(scene.sceneTitle) || ('Scene ' + (guide.scenes.length + 1)),
      voiceover: safeString_(scene.voiceover),
      action: safeString_(scene.action),
      prompt: safeString_(scene.prompt) || 'N/A'
    });
  }

  return guide;
}

// buildPlanningPrompt and output-language helpers: PlanningPrompt.gs

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

/**
 * Collects email-shaped entries from LLM workspaceSeedData for deployment-time Gmail insert.
 */
function normalizeWorkspaceSeedEmails(workspaceSeedData) {
  if (!workspaceSeedData || typeof workspaceSeedData !== 'object') return [];
  const out = [];
  const take = (arr) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (e && typeof e === 'object') out.push(e);
    }
  };
  take(workspaceSeedData.emailsToInject);
  take(workspaceSeedData.sampleEmails);
  return out.filter(e => {
    const subj = String(e.subject || '').trim();
    const body = String(
      e.bodyPlain || e.body || e.bodyMarkdown || e.body_markdown || ''
    ).trim();
    return subj.length > 0 || body.length > 0;
  });
}

/**
 * Bash + embedded Python: insert seed messages via users.messages.insert using the same
 * Desktop OAuth user credentials stored in Secret Manager as the agent.
 */
function buildWorkspaceSeedEmailInjectionBlock(emailsForInsert) {
  if (!emailsForInsert || emailsForInsert.length === 0) return '';
  const jsonBody = JSON.stringify(emailsForInsert);
  const pySnippet = `# -*- coding: utf-8 -*-
import json
import base64
from email.mime.text import MIMEText
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = [
    "https://www.googleapis.com/auth/gmail.insert",
    "https://www.googleapis.com/auth/gmail.send",
]

def main():
    path = Path(".workspace_seed_emails.json")
    raw = path.read_text(encoding="utf-8")
    msgs = json.loads(raw)
    if not isinstance(msgs, list):
        print("⚠️  workspace_seed_emails.json is not a list; skipping.")
        return
    cred_path = Path(".workspace_gmail_creds_seed.json")
    if not cred_path.is_file():
        print("⚠️  Missing Gmail OAuth user file — skipping inserts.")
        return
    creds = Credentials.from_authorized_user_file(str(cred_path), scopes=SCOPES)
    if not creds.refresh_token:
        print("⚠️  Credentials file has no refresh_token — skipping.")
        return
    creds.refresh(Request())
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    try:
        me = service.users().getProfile(userId="me").execute().get("emailAddress", "") or ""
    except HttpError as e:
        print("⚠️  Could not resolve mailbox profile:", e)
        me = ""

    inserted = 0
    for i, item in enumerate(msgs):
        subj = (item.get("subject") or "").strip() or "(Demo seed email)"
        body = (
            item.get("bodyPlain")
            or item.get("body")
            or item.get("bodyMarkdown")
            or item.get("body_markdown")
            or ""
        )
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, indent=2)
        elif not isinstance(body, str):
            body = str(body)
        frm = (item.get("from") or item.get("fromAddress") or "demo.seed@invalid").strip()
        to = (item.get("to") or item.get("toAddress") or me or "").strip()
        if not to:
            print("⚠️  Skipping seed", i + 1, "(no recipient and could not infer mailbox)")
            continue
        mime = MIMEText(body, "plain", "utf-8")
        mime["Subject"] = subj
        mime["From"] = frm
        mime["To"] = to
        raw_b64 = base64.urlsafe_b64encode(mime.as_bytes()).decode("utf-8")
        try:
            service.users().messages().insert(
                userId="me",
                body={"raw": raw_b64, "labelIds": ["INBOX", "UNREAD"]},
            ).execute()
            inserted += 1
            print("✅ Inserted seed email %d: %s..." % (inserted, subj[:60]))
        except HttpError as e:
            print("⚠️  Gmail insert failed for seed %d (%s…): %s" % (i + 1, subj[:40], e))

    print("✅ Finished workspace email seed injection (%d/%d inserted)." % (inserted, len(msgs)))


if __name__ == "__main__":
    main()
`;

  return `
# ── Workspace demo: inject LLM-authored seed emails into Gmail (authenticated inbox) ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📬 Workspace email seeds"
echo "   ${emailsForInsert.length} synthetic message(s) from demo generator (workspaceSeedData)."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cat <<'__WORKSPACE_EMAIL_SEEDS_JSON__' > .workspace_seed_emails.json
${jsonBody}
__WORKSPACE_EMAIL_SEEDS_JSON__
if [ -z "\${GMAIL_SECRET_ID}" ]; then
  echo "⚠️  Gmail was not configured (no GMAIL_SECRET_ID). Skipping seed email injection."
  echo "    Configure Gmail when prompted during setup, or run: bash \$0 --setup-gmail"
  rm -f .workspace_seed_emails.json
else
  echo "📬 Seed emails are being injected into your inbox..."
  echo "    (Gmail API users.messages.insert — same OAuth credential as Workspace tools)"
  if gcloud secrets versions access latest --secret="\${GMAIL_SECRET_ID}" --project="\${PROJECT_ID}" > .workspace_gmail_creds_seed.json 2>/dev/null; then
    if uv run python <<'PY_GMAIL_SEED_EOF'
${pySnippet}
PY_GMAIL_SEED_EOF
    then
      rm -f .workspace_seed_emails.json .workspace_gmail_creds_seed.json
      echo "✅ Gmail inbox seed injection finished."
    else
      echo "⚠️  Seed email injection script reported an error (see above)."
      rm -f .workspace_seed_emails.json .workspace_gmail_creds_seed.json
    fi
  else
    echo "⚠️  Could not read Gmail secret from Secret Manager. Skipping seed injection."
    rm -f .workspace_seed_emails.json .workspace_gmail_creds_seed.json
  fi
fi
`;
}

function generateSetupScript(params) {
  const { datasetId, systemInstruction, referenceDate, publicDatasetId, suffix, tables, userGoal, dirName, useGoogleWorkspace } = params;
  const workspaceSeedEmails = normalizeWorkspaceSeedEmails(params.workspaceSeedData || {});
  const workspaceSeedEmailInjection =
    useGoogleWorkspace && workspaceSeedEmails.length > 0
      ? buildWorkspaceSeedEmailInjectionBlock(workspaceSeedEmails)
      : '';
  const demoGuideDocUrlParam = params.demoGuideDocUrl || '';
  const demoDriveFolderUrlParam = params.demoDriveFolderUrl || '';
  const demoGuideEnvBlock = demoGuideDocUrlParam ? 'export DEMO_GUIDE_DOC_URL=' + JSON.stringify(demoGuideDocUrlParam) + '\n' : '';
  const demoDriveFolderEnvBlock = demoDriveFolderUrlParam ? 'export DEMO_DRIVE_FOLDER_URL=' + JSON.stringify(demoDriveFolderUrlParam) + '\n' : '';
  const _demoGuideShellVarRef = '$' + '{DEMO_GUIDE_DOC_URL}';
  const _demoDriveShellVarRef = '$' + '{DEMO_DRIVE_FOLDER_URL}';
  const demoArtifactsEchoSnippet =
    '\n[ -n "' +
    _demoGuideShellVarRef +
    '" ] && echo "" && echo "📄 Your Demo Guide & Script: ' +
    _demoGuideShellVarRef +
    '" && echo ""\n' +
    '[ -n "' +
    _demoDriveShellVarRef +
    '" ] && echo "📂 Your Demo Drive folder: ' +
    _demoDriveShellVarRef +
    '" && echo ""\n';
  
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
  echo "📧 Gmail OAuth Re-setup (send + inbox insert / seed emails)"
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
    --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.insert 2>&1 | tee "\$GCLOUD_AUTH_TMP"
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
${demoGuideEnvBlock}${demoDriveFolderEnvBlock}

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
echo "📧 Gmail send + inbox seed setup (OPTIONAL)"
echo "────────────────────────────────────────────────────────────────────────────"
echo "  OAuth includes gmail.send AND gmail.insert (for LLM-authored seed emails)."
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
      --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.insert 2>&1 | tee "\$GCLOUD_AUTH_TMP"
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
${workspaceSeedEmailInjection}
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
${demoArtifactsEchoSnippet}
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
${demoArtifactsEchoSnippet}
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
${demoArtifactsEchoSnippet}
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




function updateSystemInstruction(setupScript, newInstruction) {
  const escaped = newInstruction.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/\n/g, '\\n');
  return setupScript.replace(/(1\.\s+\*\*BigQuery toolset:\*\*.*?\n)([\s\S]*?)(\n\s+2\.\s+\*\*Maps Toolset:\*\*)/, `$1${escaped}$3`);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** @returns {GoogleAppsScript.Drive.Folder} */
function getOrCreateFolderByName_(parent, folderName) {
  var it = parent.getFoldersByName(folderName);
  if (it.hasNext()) return it.next();
  return parent.createFolder(folderName);
}

/** @param {Array<{id:string,fileName:string}>|null|undefined} externalFiles */
function resolveExternalFileNameById_(rid, externalFiles) {
  if (!rid || !String(rid).trim()) return '';
  var id = String(rid).trim();
  var arr = externalFiles || [];
  for (var i = 0; i < arr.length; i++) {
    var f = arr[i];
    if (!f || f.id === undefined || f.id === null) continue;
    if (String(f.id) === id && f.fileName) return String(f.fileName);
  }
  return '';
}

function stripMarkdownBoldMarkers_(text) {
  return String(text || '').replace(/\*\*/g, '');
}

/**
 * Markdown demo guide (primary) + optional legacy storyboard object for doc fallbacks.
 */
function buildDemoGuideDocAssembly_(planResult) {
  var md = planResult && planResult.demoGuideMarkdown ? String(planResult.demoGuideMarkdown).trim() : '';
  var rawStoryboard = planResult && planResult.demoGuideStoryboard ? planResult.demoGuideStoryboard : (planResult ? planResult.demoGuideStructured : null);
  var storyboard = normalizeStoryboardGuide_(rawStoryboard);
  return { narratorMarkdown: md, storyboard: storyboard };
}

function applyMarkdownBoldToElement_(element, plainTextLine) {
  var plain = plainTextLine === null || plainTextLine === undefined ? '' : String(plainTextLine);
  var parts = plain.split('**');
  if (parts.length <= 1) {
    element.setText(plain);
    return;
  }

  var newText = '';
  var boldRanges = [];
  var j;
  for (j = 0; j < parts.length; j++) {
    if (j % 2 === 1) {
      var start = newText.length;
      newText += parts[j];
      boldRanges.push({ start: start, end: newText.length - 1 });
    } else {
      newText += parts[j];
    }
  }
  element.setText(newText);
  var textElement = element.editAsText();
  for (var b = 0; b < boldRanges.length; b++) {
    var r = boldRanges[b];
    textElement.setBold(r.start, r.end, true);
  }
}

function appendLabelValueParagraph_(container, label, value) {
  var p = container.appendParagraph('');
  p.appendText(label + ': ').setBold(true);
  p.appendText(safeString_(value));
  return p;
}

function fillGoogleDocBodyFromStoryboard_(body, storyboardData) {
  var storyboard = normalizeStoryboardGuide_(storyboardData);

  body.appendParagraph(storyboard.demoTitle + ' AWT Demo Flow');
  body.appendParagraph('');
  body.appendParagraph('Creator: Auto-generated');
  body.appendParagraph('Status: Draft');
  body.appendParagraph('Resources:');
  body.appendParagraph('Demo Account: [placeholder]');
  body.appendParagraph('Google Drive folder: [placeholder]');
  body.appendParagraph('Gemini Enterprise URL: [placeholder]');
  body.appendParagraph('Storyboard: ' + storyboard.storyboardTitle);
  body.appendParagraph('Intro: ' + storyboard.intro);
  body.appendParagraph('');

  var table = body.appendTable();
  var headerRow = table.appendTableRow();
  var scriptHeader = headerRow.appendTableCell('Script for Sales Person');
  scriptHeader.editAsText().setBold(true);
  var uxHeader = headerRow.appendTableCell('UX');
  uxHeader.editAsText().setBold(true);

  var scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  for (var i = 0; i < scenes.length; i++) {
    var scene = scenes[i] || {};
    var row = table.appendTableRow();
    var leftCell = row.appendTableCell('');
    var rightCell = row.appendTableCell('');

    var sceneTitle = leftCell.appendParagraph(safeString_(scene.sceneTitle) || ('Scene ' + (i + 1)));
    sceneTitle.editAsText().setBold(true);
    appendLabelValueParagraph_(leftCell, 'Voiceover', scene.voiceover);
    appendLabelValueParagraph_(leftCell, 'Action', scene.action);
    appendLabelValueParagraph_(leftCell, 'Prompt', scene.prompt || 'N/A');

    var ux = rightCell.appendParagraph('[Screenshot Placeholder]');
    ux.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    ux.editAsText().setItalic(true).setForegroundColor('#808080');
  }
}

/** Renders planner Markdown (#/##/###, - bullets, **bold**) into the document body. */
function fillGoogleDocBodyFromMarkdownContent_(body, markdownContent) {
  var content = markdownContent === null || markdownContent === undefined ? '' : String(markdownContent);
  var lines = content.split(/\r?\n/);
  var li;
  for (li = 0; li < lines.length; li++) {
    var trimmed = lines[li].trim();
    if (!trimmed) {
      body.appendParagraph('');
      continue;
    }

    var hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      var lvl = hMatch[1].length;
      var htext = hMatch[2];
      var pHeading = DocumentApp.ParagraphHeading.NORMAL;
      if (lvl === 1) pHeading = DocumentApp.ParagraphHeading.HEADING1;
      else if (lvl === 2) pHeading = DocumentApp.ParagraphHeading.HEADING2;
      else pHeading = DocumentApp.ParagraphHeading.HEADING3;
      var hp = body.appendParagraph('');
      hp.setHeading(pHeading);
      applyMarkdownBoldToElement_(hp, htext);
      continue;
    }

    var bulletDash = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletDash) {
      var btext = bulletDash[1];
      var lp = body.appendListItem(btext);
      lp.setGlyphType(DocumentApp.GlyphType.BULLET);
      applyMarkdownBoldToElement_(lp, btext);
      continue;
    }

    var np = body.appendParagraph('');
    np.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    applyMarkdownBoldToElement_(np, trimmed);
  }
}

/** @param {Array<{index:number,title:string,attachmentName:string,promptPlain:string}>} appendixPrompts */
function appendPromptAppendixToBody_(body, appendixPrompts) {
  if (!appendixPrompts || appendixPrompts.length === 0) return;
  body.appendParagraph('');
  var h2 = body.appendParagraph('Copy-paste prompts');
  h2.setHeading(DocumentApp.ParagraphHeading.HEADING2);

  for (var pi = 0; pi < appendixPrompts.length; pi++) {
    var ap = appendixPrompts[pi];
    var h3 = body.appendParagraph('Prompt ' + ap.index + ': ' + ap.title);
    h3.setHeading(DocumentApp.ParagraphHeading.HEADING3);

    body.appendParagraph(
      ap.attachmentName
        ? 'Attachment — upload this file when running the demo: ' + ap.attachmentName
        : 'Attachment — none required for this prompt.'
    );

    body.appendParagraph('Prompt text (copy into the agent):');
    var pLines = String(ap.promptPlain || '').split(/\r?\n/);
    for (var lj = 0; lj < pLines.length; lj++) {
      var pl = body.appendParagraph(pLines[lj]);
      pl.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    }
  }
}

function mimeBlobTypeForDemoFile_(externalFileEntry) {
  var fn = (externalFileEntry && externalFileEntry.fileName) ? String(externalFileEntry.fileName).toLowerCase() : '';
  var m = (externalFileEntry && externalFileEntry.mimeType) ? String(externalFileEntry.mimeType).toLowerCase() : '';
  if (m.indexOf('pdf') >= 0 || fn.endsWith('.pdf')) return MimeType.PDF;
  if (m.indexOf('spreadsheet') >= 0 || m.indexOf('excel') >= 0 || fn.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (fn.endsWith('.csv')) return 'text/csv';
  return MimeType.PLAIN_TEXT;
}

/**
 * Planner Excel payloads are TSV (tabs); builds a rectangular grid for Sheets.
 * @returns {string[][]}
 */
function parseTabSeparatedGridForSheet_(rawContent) {
  var text = rawContent === undefined || rawContent === null ? '' : String(rawContent);
  var lines = text.split(/\r?\n/);
  var rows = [];
  var maxCols = 0;
  var li;
  for (li = 0; li < lines.length; li++) {
    var cells = lines[li].split('\t');
    var ci;
    for (ci = 0; ci < cells.length; ci++) {
      var v = cells[ci];
      if (v.length > 50000) cells[ci] = v.substring(0, 50000);
    }
    rows.push(cells);
    if (cells.length > maxCols) maxCols = cells.length;
  }
  if (maxCols === 0) return [['']];
  var ri;
  for (ri = 0; ri < rows.length; ri++) {
    while (rows[ri].length < maxCols) rows[ri].push('');
  }
  return rows;
}

/** Safe spreadsheet title from planned .xlsx file name. */
function spreadsheetTitleFromExcelFileName_(fileName) {
  var base = String(fileName || 'spreadsheet').replace(/\.xlsx$/i, '');
  base = base.replace(/[\\/]/g, '-').trim();
  if (!base) base = 'spreadsheet';
  if (base.length > 99) base = base.substring(0, 99);
  return base;
}

/**
 * Creates a native Google Sheet from TSV-style content, moves it into the demo folder, then adds a real .xlsx
 * exported from that sheet (binary matches Google's Excel export for the same grid).
 */
function provisionGoogleSheetAndXlsxFromTsvContent_(agentFolder, externalFileEntry, rawContent) {
  var ex = externalFileEntry || {};
  var fileName = ex.fileName ? String(ex.fileName) : 'export.xlsx';
  var title = spreadsheetTitleFromExcelFileName_(fileName);
  var grid = parseTabSeparatedGridForSheet_(rawContent);
  var numRows = grid.length;
  var numCols = grid[0].length;

  var ss = SpreadsheetApp.create(title);
  var sheet = ss.getSheets()[0];
  sheet.getRange(1, 1, numRows, numCols).setValues(grid);
  SpreadsheetApp.flush();

  var sheetFile = DriveApp.getFileById(ss.getId());
  sheetFile.moveTo(agentFolder);
  sheetFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var xlsxBlob = sheetFile.getAs(MimeType.MICROSOFT_EXCEL);
  xlsxBlob.setName(fileName);
  var xlsxDriveFile = agentFolder.createFile(xlsxBlob);
  xlsxDriveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
}

function isDemoExternalPdf_(externalFileEntry) {
  var fn = (externalFileEntry && externalFileEntry.fileName) ? String(externalFileEntry.fileName).toLowerCase() : '';
  var m = (externalFileEntry && externalFileEntry.mimeType) ? String(externalFileEntry.mimeType).toLowerCase() : '';
  return m.indexOf('pdf') >= 0 || fn.endsWith('.pdf');
}

function isDemoExternalExcel_(externalFileEntry) {
  var fn = (externalFileEntry && externalFileEntry.fileName) ? String(externalFileEntry.fileName).toLowerCase() : '';
  var m = (externalFileEntry && externalFileEntry.mimeType) ? String(externalFileEntry.mimeType).toLowerCase() : '';
  return fn.endsWith('.xlsx') || m.indexOf('spreadsheet') >= 0 || m.indexOf('excel') >= 0;
}

/**
 * Renders markdown-like external PDF text into a Google Doc body (same rules as generatePdfFromServer).
 */
function fillTempDocBodyForExternalPdf_(body, content) {
  function applyBold(element, text) {
    if (!text) return;
    var parts = text.split('**');
    if (parts.length <= 1) return;

    var newText = '';
    var boldRanges = [];
    var i;
    for (i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var start = newText.length;
        newText += parts[i];
        boldRanges.push({ start: start, end: newText.length - 1 });
      } else {
        newText += parts[i];
      }
    }

    element.setText(newText);
    var textElement = element.editAsText();
    for (i = 0; i < boldRanges.length; i++) {
      var r = boldRanges[i];
      textElement.setBold(r.start, r.end, true);
    }
  }

  var lines = String(content || '').split(/\r?\n/);
  var idx;
  for (idx = 0; idx < lines.length; idx++) {
    var line = lines[idx];
    var trimmed = line.trim();
    if (!trimmed) {
      body.appendParagraph('');
      continue;
    }

    if (trimmed.indexOf('# ') === 0) {
      var p1 = body.appendParagraph(trimmed.substring(2));
      p1.setHeading(DocumentApp.ParagraphHeading.HEADING1);
      applyBold(p1, trimmed.substring(2));
    } else if (trimmed.indexOf('## ') === 0) {
      var p2 = body.appendParagraph(trimmed.substring(3));
      p2.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      applyBold(p2, trimmed.substring(3));
    } else if (trimmed.indexOf('### ') === 0) {
      var p3 = body.appendParagraph(trimmed.substring(4));
      p3.setHeading(DocumentApp.ParagraphHeading.HEADING3);
      applyBold(p3, trimmed.substring(4));
    } else if (trimmed.indexOf('- ') === 0) {
      var li = body.appendListItem(trimmed.substring(2));
      applyBold(li, trimmed.substring(2));
    } else if (trimmed.indexOf('[CHART:') === 0) {
      var match = trimmed.match(/\[CHART:\s*(BAR|PIE|LINE)?,?\s*([^,\]]+),\s*([^\]]+)\]/i);
      if (match) {
        var type = (match[1] || 'BAR').toUpperCase();
        var chartTitle = match[2].trim();
        var dataStr = match[3].trim();
        var pairs = dataStr.split(',');
        var dataTable = Charts.newDataTable();
        dataTable.addColumn(Charts.ColumnType.STRING, 'Item');
        dataTable.addColumn(Charts.ColumnType.NUMBER, 'Value');
        var pi;
        for (pi = 0; pi < pairs.length; pi++) {
          var pair = pairs[pi].trim();
          var eq = pair.split('=');
          if (eq.length === 2) {
            dataTable.addRow([eq[0].trim(), parseFloat(eq[1].trim()) || 0]);
          }
        }
        var builder;
        if (type === 'PIE') builder = Charts.newPieChart();
        else if (type === 'LINE') builder = Charts.newLineChart();
        else builder = Charts.newBarChart();

        var chart = builder
          .setDataTable(dataTable.build())
          .setTitle(chartTitle)
          .setDimensions(600, 300)
          .build();

        var imageBlob = chart.getAs('image/png');
        body.appendImage(imageBlob);
      } else {
        var pF = body.appendParagraph(trimmed);
        applyBold(pF, trimmed);
      }
    } else {
      var pN = body.appendParagraph(trimmed);
      applyBold(pN, trimmed);
    }
  }
}

/**
 * Valid PDF bytes for Drive / desktop: render via Google Docs export, not raw text as application/pdf.
 */
function createDrivePdfBlobFromExternalFileContent_(content, fileName) {
  var tempTitle = 'Temp PDF ' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
  var doc = DocumentApp.create(tempTitle);
  var body = doc.getBody();
  fillTempDocBodyForExternalPdf_(body, content);
  doc.saveAndClose();
  var docId = doc.getId();
  var driveFile = DriveApp.getFileById(docId);
  var pdfBlob = driveFile.getAs(MimeType.PDF);
  pdfBlob.setName(fileName || 'document.pdf');
  driveFile.setTrashed(true);
  return pdfBlob;
}

/**
 * Places Demo Guide Doc + attachment blobs under Demo/{dirName}; link-sharing on folder & doc.
 */
function provisionDemoDriveKit_(dirName, storyboardData, markdownContent, externalFiles, docTitle) {
  var out = {
    success: false,
    demoGuideDocUrl: '',
    demoDriveFolderUrl: '',
    demoGuideDocId: ''
  };

  try {
    var safeTitle = docTitle ? String(docTitle).trim() : 'Demo Guide & Script';
    if (safeTitle.length > 150) safeTitle = safeTitle.substring(0, 150);

    var demoRoot = getOrCreateFolderByName_(DriveApp.getRootFolder(), 'Demo');
    var agentFolder = getOrCreateFolderByName_(demoRoot, dirName);

    var doc = DocumentApp.create(safeTitle);
    var docId = doc.getId();
    var body = doc.getBody();
    var md = markdownContent !== undefined && markdownContent !== null ? String(markdownContent).trim() : '';
    if (md) {
      fillGoogleDocBodyFromMarkdownContent_(body, md);
    } else {
      fillGoogleDocBodyFromStoryboard_(body, storyboardData || {});
    }
    doc.saveAndClose();

    var docFile = DriveApp.getFileById(docId);
    docFile.moveTo(agentFolder);
    docFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    agentFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // Expose guide + folder URLs before attachment loop so UI still gets links if PDF/Sheet steps fail
    // (Drive may contain doc + partial assets; users can refresh or re-run for missing files).
    out.demoGuideDocUrl = docFile.getUrl();
    out.demoDriveFolderUrl = agentFolder.getUrl();
    out.demoGuideDocId = docId;

    var xf = externalFiles || [];
    for (var xi = 0; xi < xf.length; xi++) {
      var ex = xf[xi];
      if (!ex || !ex.fileName) continue;
      try {
        var rawContent = ex.fileContent !== undefined && ex.fileContent !== null ? String(ex.fileContent) : '';
        if (isDemoExternalPdf_(ex)) {
          var pdfBlob = createDrivePdfBlobFromExternalFileContent_(rawContent, ex.fileName);
          var pdfFile = agentFolder.createFile(pdfBlob);
          pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          continue;
        }
        if (isDemoExternalExcel_(ex)) {
          provisionGoogleSheetAndXlsxFromTsvContent_(agentFolder, ex, rawContent);
          continue;
        }
        var blob = Utilities.newBlob(rawContent, mimeBlobTypeForDemoFile_(ex), ex.fileName);
        var f = agentFolder.createFile(blob);
        f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (attErr) {
        console.error('[DemoDriveKit] attachment failed:', ex.fileName, attErr.message);
      }
    }

    out.success = true;
    return out;
  } catch (e) {
    console.error('[DemoDriveKit]', e.message);
    out.error = e.message;
    return out;
  }
}

/**
 * @deprecated Structured storyboard guides replaced Markdown narration.
 */
function buildDemoGuideMarkdownFromPlan(planResult) {
  if (!planResult) return '';
  const primary = String(planResult.demoGuideMarkdown || '').trim();
  if (primary) return primary;

  var prompts = planResult.demoGuide;
  if (!Array.isArray(prompts) || prompts.length === 0) return '';

  var lines = [];
  for (var i = 0; i < prompts.length; i++) {
    var step = prompts[i];
    if (!step || typeof step !== 'object') continue;
    lines.push('## ' + String(step.title || 'Demo scenario ' + (i + 1)));
    lines.push('');
    lines.push(String(step.prompt || ''));
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Creates a Google Doc from basic Markdown (#/##/###, - bullets, **bold**), optional appendix prompts, shares view-anyone-with-link.
 * @returns {{success:boolean, url?: string, docId?: string, error?: string}}
 */
function createGoogleDocFromMarkdown(markdownContent, docTitle, appendixPrompts) {
  try {
    var titleBase = docTitle ? String(docTitle).trim() : 'Demo Guide & Script';
    if (titleBase.length > 150) titleBase = titleBase.substring(0, 150);

    var doc = DocumentApp.create(titleBase);
    var body = doc.getBody();
    fillGoogleDocBodyFromMarkdownContent_(body, markdownContent || '');
    appendPromptAppendixToBody_(body, appendixPrompts || []);

    doc.saveAndClose();

    var docId = doc.getId();
    var file = DriveApp.getFileById(docId);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var url = file.getUrl();
    return { success: true, url: url, docId: docId };
  } catch (e) {
    console.error('Demo guide Doc failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Generates a text-based PDF from content using DocumentApp.
 * @param {string} content - The content to written into the PDF.
 * @param {string} fileName - The name of the generated PDF file.
 * @returns {object} { success: boolean, base64: string, error?: string }
 */
function generatePdfFromServer(content, fileName) {
  try {
    var pdfBlob = createDrivePdfBlobFromExternalFileContent_(content, fileName);
    var base64 = Utilities.base64Encode(pdfBlob.getBytes());
    return { success: true, base64: base64 };
  } catch (e) {
    console.error('PDF generation failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * IDS Widget - WASM-based IFC/IDS Validation for StreamBIM
 * Uses Pyodide (Python in WASM) to run ifcopenshell/ifctester in the browser
 */

// Dynamic import with cache busting to ensure fresh module code
let wasm = null;
const wasmModulePromise = import(`./wasm/index.js?t=${Date.now()}`).then(module => {
    wasm = module.default;
    return wasm;
});

var jsondata = '';
var projectID = '';
var baseUrl = ''; // Dynamically set based on StreamBIM host
var wasmInitialized = false;
var wasmInitializing = false;

// Cache name for IFC/IDS files
const FILE_CACHE_NAME = 'ids-widget-files-v1';

// Pending downloads (started when user selects files)
let pendingIfcDownload = null;
let pendingIdsDownload = null;

// Store selected file metadata for cache keys
let selectedIfcMeta = null;
let selectedIdsMeta = null;

/**
 * Generate cache key from StreamBIM file metadata
 * Key format: file_{documentId}_{revisionId}_{uploadDate}
 */
function getFileCacheKey(documentId, revisionId, uploadDate) {
    // Sanitize uploadDate to be URL-safe
    const safeUploadDate = uploadDate ? uploadDate.replace(/[^a-zA-Z0-9-_]/g, '_') : 'unknown';
    return `file_${documentId}_${revisionId || 'none'}_${safeUploadDate}`;
}

/**
 * Download file with caching - uses StreamBIM metadata to detect changes
 */
async function downloadFileWithCache(downloadLink, documentId, revisionId, uploadDate) {
    const cacheKey = getFileCacheKey(documentId, revisionId, uploadDate);
    
    try {
        const cache = await caches.open(FILE_CACHE_NAME);
        
        // Check if we have this exact version cached
        const cached = await cache.match(cacheKey);
        if (cached) {
            console.log('[IDS Widget] Using cached file:', cacheKey);
            return cached.arrayBuffer();
        }
        
        // Download fresh copy
        console.log('[IDS Widget] Downloading file (not cached):', downloadLink);
        const data = await downloadFile(downloadLink);
        
        // Cache the response for future use
        const response = new Response(data, {
            headers: { 
                'Content-Type': 'application/octet-stream',
                'X-Cache-Key': cacheKey,
                'X-Cached-At': new Date().toISOString()
            }
        });
        await cache.put(cacheKey, response);
        console.log('[IDS Widget] File cached:', cacheKey);
        
        return data;
    } catch (e) {
        // If cache fails (e.g., private browsing), fall back to direct download
        console.warn('[IDS Widget] Cache unavailable, downloading directly:', e.message);
        return downloadFile(downloadLink);
    }
}

// Use the connection established by the inline sync script in idswidget.py
// ES modules are deferred, so we can't call connect() here (too late)
// Using v2 API: StreamBIM.methodName() instead of StreamBIM.methodName()
console.log("IDS Widget loaded (WASM version)");

// Start WASM initialization immediately in the background
// This runs while the user selects files, significantly reducing wait time on validate
let wasmInitPromise = null;

function startEarlyWasmInit() {
    if (!wasmInitPromise && !wasmInitialized) {
        console.log('[IDS Widget] Starting early WASM initialization in background...');
        wasmInitPromise = initializeWasm().then(() => {
            console.log('[IDS Widget] Background WASM init complete!');
            return true;
        }).catch(err => {
            console.warn('[IDS Widget] Background WASM init failed:', err.message);
            wasmInitPromise = null; // Allow retry on validate
            return false;
        });
    }
    return wasmInitPromise;
}

// Start initialization immediately on module load
startEarlyWasmInit();

// Use the early connection established by sync script, or fall back to new connection (v2 API)
// Note: expandedChanged callback is registered in the inline sync script (idswidget.py)
// to ensure it's available before this ES module loads
const connectPromise = window._streamBIMConnection || StreamBIM.connect({});

connectPromise.then(function() {
    console.log("StreamBIM connected (module)");
    initializeWidget();
}).catch(function(error) {
    console.error("Failed to connect to StreamBIM:", error);
});

/**
 * Determine the StreamBIM base URL from the parent frame context
 * The widget runs in an iframe, so we derive the host from document.referrer
 */
function getStreamBimBaseUrl() {
    // Priority 1: Check URL parameter for testing/override (e.g., ?streambim_host=https://client.streambim.com)
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const hostParam = urlParams.get('streambim_host');
        if (hostParam) {
            console.log('[IDS Widget] Using streambim_host from URL parameter:', hostParam);
            return hostParam;
        }
    } catch (e) {}
    
    // Priority 2: Use ancestorOrigins if available (Chrome/Edge/Safari support)
    // This reliably provides the parent frame's origin even with cross-origin restrictions
    try {
        if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
            const ancestorOrigin = window.location.ancestorOrigins[0];
            console.log('[IDS Widget] Using ancestorOrigins:', ancestorOrigin);
            return ancestorOrigin;
        }
    } catch (e) {}
    
    // Priority 3: Use document.referrer (fallback for browsers without ancestorOrigins)
    try {
        if (document.referrer) {
            const url = new URL(document.referrer);
            return url.origin;
        }
    } catch (e) {
        console.warn('[IDS Widget] Could not parse referrer:', e);
    }
    
    // Priority 4: Try to get from parent location (may fail due to CORS)
    try {
        if (window.parent && window.parent !== window) {
            return window.parent.location.origin;
        }
    } catch (e) {
        // Expected to fail due to cross-origin restrictions
    }
    
    // Last resort fallback
    console.warn('[IDS Widget] Could not determine StreamBIM host, using default');
    return 'https://app.streambim.com';
}

/**
 * Initialize the widget after StreamBIM connection is established
 */
function initializeWidget() {
    // Determine the StreamBIM base URL dynamically
    baseUrl = getStreamBimBaseUrl();
    console.log('[IDS Widget] Using StreamBIM base URL:', baseUrl);
    
    // Set StreamBIM styles
    StreamBIM.setStyles(".color-code-values--left-sliders-active {margin-left: 40%;}");
    
    // Get project ID and load files
    StreamBIM.getProjectId().then((result) => {
        projectID = result;
        loadFileSelectors();
        setupClickHandlers();
        setupValidateButton();
        setupFileSelectionHandlers();
    }).catch((error) => console.error("Error getting project ID:", error));
}

/**
 * Setup handlers for file selection changes
 */
function setupFileSelectionHandlers() {
    const ifcSelect = document.querySelector('select[name="ifc_filename"]');
    const idsSelect = document.querySelector('select[name="ids_filename"]');
    
    if (ifcSelect) {
        ifcSelect.addEventListener('change', onIfcSelected);
    }
    
    if (idsSelect) {
        idsSelect.addEventListener('change', onIdsSelected);
    }
}

/**
 * Handle IFC file selection - start fetching in background
 */
async function onIfcSelected(event) {
    const select = event.target;
    const selectedOption = select.options[select.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) {
        pendingIfcDownload = null;
        selectedIfcMeta = null;
        return;
    }
    
    const documentId = selectedOption.value;
    const revisionId = selectedOption.dataset.revId || null;
    const uploadDate = selectedOption.dataset.uploadDate || null;
    
    // Store metadata for cache key
    selectedIfcMeta = { documentId, revisionId, uploadDate };
    
    console.log('[IDS Widget] IFC selected:', selectedOption.text);
    
    // Start fetching in background (will use cache if available)
    pendingIfcDownload = (async () => {
        try {
            const downloadLink = await StreamBIM.makeApiRequest({ 
                url: `${baseUrl}/project-${projectID}/api/v1/documents/${documentId}/downloadlink` 
            });
            return downloadFileWithCache(downloadLink, documentId, revisionId, uploadDate);
        } catch (e) {
            console.warn('[IDS Widget] Background IFC fetch failed:', e.message);
            return null;
        }
    })();
}

// Store IDS validation result for use during audit
let idsValidationResult = null;

/**
 * Handle IDS file selection - start fetching and validating in background
 */
async function onIdsSelected(event) {
    const select = event.target;
    const selectedOption = select.options[select.selectedIndex];
    
    // Clear any previous validation messages
    clearIdsValidationMessage();
    idsValidationResult = null;
    
    if (!selectedOption || !selectedOption.value) {
        pendingIdsDownload = null;
        selectedIdsMeta = null;
        return;
    }
    
    const documentId = selectedOption.value;
    const revisionId = selectedOption.dataset.revId || null;
    const uploadDate = selectedOption.dataset.uploadDate || null;
    const filename = selectedOption.text;
    
    // Store metadata for cache key
    selectedIdsMeta = { documentId, revisionId, uploadDate, filename };
    
    console.log('[IDS Widget] IDS selected:', filename);
    
    // Start fetching in background (will use cache if available)
    pendingIdsDownload = (async () => {
        try {
            const downloadLink = await StreamBIM.makeApiRequest({ 
                url: `${baseUrl}/project-${projectID}/api/v1/documents/${documentId}/downloadlink` 
            });
            const data = await downloadFileWithCache(downloadLink, documentId, revisionId, uploadDate);
            
            // Once downloaded, validate the IDS file in the background
            if (data) {
                validateIdsInBackground(data, filename);
            }
            
            return data;
        } catch (e) {
            console.warn('[IDS Widget] Background IDS fetch failed:', e.message);
            return null;
        }
    })();
}

/**
 * Validate IDS file in background and show feedback to user
 */
async function validateIdsInBackground(idsData, filename) {
    try {
        // Make sure WASM is initialized
        await initializeWasm();
        
        console.log('[IDS Widget] Validating IDS file:', filename);
        const result = await wasm.validateIds(idsData);
        idsValidationResult = result;
        
        if (result.success && result.valid) {
            // IDS is valid - just log it, don't show success message to user
            console.log('[IDS Widget] IDS file valid:', result.specifications_count, 'specifications');
            if (result.entity_types?.length > 0) {
                console.log('[IDS Widget] IDS references entity types:', result.entity_types);
            }
            // Clear any previous error message
            clearIdsValidationMessage();
        } else if (result.success && !result.valid) {
            // IDS structure is invalid
            showIdsValidationMessage('error', result.error || 'Invalid IDS file structure');
            console.error('[IDS Widget] IDS validation failed:', result.error);
        } else {
            // Unexpected error
            showIdsValidationMessage('warning', 'Could not validate IDS file');
            console.warn('[IDS Widget] IDS validation error:', result.error);
        }
    } catch (e) {
        console.warn('[IDS Widget] Background IDS validation failed:', e.message);
        // Don't show error - WASM might not be ready yet, validation will happen during audit
    }
}

/**
 * Show IDS validation message to user
 */
function showIdsValidationMessage(type, message) {
    clearIdsValidationMessage();
    
    const container = document.querySelector('.file-selection-container');
    if (!container) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.id = 'ids-validation-message';
    msgDiv.className = `ids-validation-${type}`;
    msgDiv.innerHTML = `<span class="ids-validation-icon"></span>${escapeHtml(message)}`;
    
    container.insertAdjacentElement('afterend', msgDiv);
}

/**
 * Clear IDS validation message
 */
function clearIdsValidationMessage() {
    const existing = document.getElementById('ids-validation-message');
    if (existing) {
        existing.remove();
    }
}

/**
 * Load the IFC and IDS file selectors
 */
function loadFileSelectors() {
    const queryIds = { filter: { freetext: ".ids", isDeleted: false } };
    const base64queryIds = btoa(JSON.stringify(queryIds));
    
    StreamBIM.makeApiRequest({url: `${baseUrl}/project-${projectID}/api/v1/documents/export/json/?query=${base64queryIds}`})
    .then(response => JSON.parse(response))
    .then(idsDocuments => populateSelectElement(idsDocuments, 'ids_filename'))
    .then(() => {
        const idsSelect = document.querySelector('select[name="ids_filename"]');
        if (idsSelect) {
            idsSelect.disabled = false;
            idsSelect.options[0].text = "Select IDS file for Validation...";
            createSearchableSelect(idsSelect);
        }
    })
    .catch(error => console.error("Error fetching ids documents:", error));

    const queryIfc = { filter: { freetext: ".ifc", isDeleted: false } };
    const base64queryIfc = btoa(JSON.stringify(queryIfc));
    
    StreamBIM.makeApiRequest({url: `${baseUrl}/project-${projectID}/api/v1/documents/export/json/?query=${base64queryIfc}`})
    .then(response => JSON.parse(response))
    .then(ifcDocuments => populateSelectElement(ifcDocuments, 'ifc_filename'))
    .then(() => {
        const ifcSelect = document.querySelector('select[name="ifc_filename"]');
        if (ifcSelect) {
            ifcSelect.disabled = false;
            ifcSelect.options[0].text = "Select IFC file for Validation...";
            createSearchableSelect(ifcSelect);
        }
    })
    .catch(error => console.error("Error fetching documents:", error));
}

/**
 * Setup click handlers for report interactions
 */
function setupClickHandlers() {
    document.addEventListener("click", function(event) {
        if (event.target.classList.contains("goto-btn")) {
            gotoObject(event.target.dataset.guid);
        } else if (event.target.classList.contains("highlight") && event.target.classList.contains("element")) {
            highlightObject(event.target.dataset.guid);
        } else if (event.target.classList.contains("highlight") && event.target.classList.contains("grouped_clashes")) {
            highlightGroup(event.target.dataset.groupIndex);
        } else if (event.target.classList.contains("highlight") && event.target.classList.contains("model_clashes")) {
            highlightModelClashes(event.target.dataset.groupIndex);
        } else if (event.target.classList.contains("highlight") && event.target.classList.contains("failed_entities")) {
            highlightFailedEntities(event.target.dataset.specIndex, event.target.dataset.reqIndex);
        } else if (event.target.classList.contains("copy-btn")) {
            copyToClipboard(event.target);
        } else if (event.target.classList.contains("copy-btn") && event.target.classList.contains("failed_entities")) {
            copyToClipboardEntities(event.target, event.target.dataset.specIndex, event.target.dataset.reqIndex);
        }
    });
}

/**
 * Initialize the WASM module
 */
async function initializeWasm() {
    if (wasmInitialized) return true;
    if (wasmInitializing) {
        // Wait for initialization to complete
        while (wasmInitializing) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return wasmInitialized;
    }

    wasmInitializing = true;

    try {
        // Ensure wasm module is loaded (from dynamic import)
        await wasmModulePromise;
        
        await wasm.init((progress) => {
            console.log('[WASM]', progress.message, progress.percent);
        });
        
        wasmInitialized = true;
        console.log('[IDS Widget] WASM module initialized');
        return true;
    } catch (error) {
        console.error('[IDS Widget] Failed to initialize WASM:', error);
        const loadingIndicator = document.getElementById('loading-indicator');
        if (loadingIndicator) {
            loadingIndicator.innerHTML = `<div class="error">Failed to initialize validation engine: ${error.message}</div>`;
        }
        throw error;
    } finally {
        wasmInitializing = false;
    }
}

/**
 * Download a file from StreamBIM as ArrayBuffer
 * Uses server-side proxy to avoid CORS issues
 */
async function downloadFile(downloadLink) {
    const fullUrl = `${baseUrl}/project-${projectID}/api/v1/${downloadLink}`;
    
    // Use proxy endpoint to avoid CORS issues
    // Cookies are automatically forwarded by the browser
    const response = await fetch(`/proxy/download?url=${encodeURIComponent(fullUrl)}`, {
        credentials: 'include' // Include cookies so server can forward them
    });
    
    if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }
    
    return await response.arrayBuffer();
}

/**
 * Perform WASM-based validation
 */
async function validateWithWasm(ifcData, idsData) {
    // Ensure WASM is initialized
    await initializeWasm();
    
    // If we don't have a pre-validation result, validate the IDS now
    if (!idsValidationResult) {
        console.log('[IDS Widget] No pre-validation result, validating IDS now...');
        idsValidationResult = await wasm.validateIds(idsData);
    }
    
    // Check if IDS is valid
    if (idsValidationResult && !idsValidationResult.valid) {
        return {
            success: false,
            error: idsValidationResult.error || 'Invalid IDS file',
            error_type: 'ids_xml_validation'
        };
    }
    
    // Load IFC file and get schema info
    const loadResult = await wasm.loadIfc(ifcData);
    const ifcId = loadResult.ifcId;
    const ifcSchema = loadResult.schema;
    console.log('[IDS Widget] IFC loaded with ID:', ifcId, 'schema:', ifcSchema);
    
    // Check schema compatibility BEFORE running full validation
    // This prevents the fatal Pyodide crash
    if (idsValidationResult && idsValidationResult.entity_types) {
        const incompatible = await checkEntityTypesCompatibility(ifcSchema, idsValidationResult.entity_types);
        if (incompatible.length > 0) {
            // Cleanup before returning error
            await wasm.unloadIfc(ifcId);
            
            const entityList = incompatible.slice(0, 10).join(', ');
            const moreCount = incompatible.length > 10 ? incompatible.length - 10 : 0;
            const moreText = moreCount > 0 ? ` and ${moreCount} more` : '';
            
            // Determine IDS target version from validation result
            const idsTargets = idsValidationResult.ifc_versions || [];
            const idsTargetText = idsTargets.length > 0 ? idsTargets.join('/') : 'IFC4';
            
            return {
                success: false,
                error: `The IDS file is designed for ${idsTargetText}, but the IFC model uses ${ifcSchema}. The following entity types are not available in ${ifcSchema}: ${entityList}${moreText}.`,
                error_type: 'schema_mismatch',
                incompatible_entities: incompatible,
                ids_schema: idsTargetText,
                ifc_schema: ifcSchema
            };
        }
    }
    
    try {
        // Run full validation
        const result = await wasm.auditIfc(ifcId, idsData);
        console.log('[IDS Widget] Validation complete:', result);
        return result;
    } finally {
        // Cleanup: unload the IFC file
        await wasm.unloadIfc(ifcId);
    }
}

/**
 * Check if entity types are compatible with an IFC schema
 * This runs in Python via WASM to use ifcopenshell's schema definitions
 */
async function checkEntityTypesCompatibility(ifcSchema, entityTypes) {
    if (!entityTypes || entityTypes.length === 0) return [];
    
    try {
        const result = await wasm._apiCall('checkEntityTypes', ifcSchema, entityTypes);
        return result.incompatible || [];
    } catch (e) {
        console.warn('[IDS Widget] Entity type check failed:', e.message);
        // Fall back to letting the Python validation handle it
        return [];
    }
}

/**
 * Setup the validate button click handler
 */
function setupValidateButton() {
    const validateBtn = document.getElementById('validate');
    if (validateBtn) {
        validateBtn.addEventListener('click', handleValidateClick);
    }
}

function populateSelectElement(json, selectName) {
    console.log(json);
    var select = document.querySelector(`select[name="${selectName}"]`);
    
    // Clear existing options except the first one
    while (select.options.length > 1) {
        select.remove(1);
    }

    // Add the select element to the page
    json.data.forEach(function(item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.filename;
        option.dataset.uploadDate = item.uploadedDate;
        option.dataset.filesize = item.filesize;
        
        if (item.revision) {
            option.dataset.revId = item.revision;
        }
        select.appendChild(option);
    });
}

function createSearchableSelect(selectElement) {
    const container = document.createElement('div');
    container.className = 'searchable-select-container';

    const wrapper = document.createElement('div');
    wrapper.className = 'searchable-select';
    wrapper.innerHTML = selectElement.options[selectElement.selectedIndex].text;

    const dropdown = document.createElement('div');
    dropdown.className = 'searchable-select-dropdown';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'searchable-select-search';
    searchInput.placeholder = 'Search...';

    dropdown.appendChild(searchInput);

    Array.from(selectElement.options).forEach((option, index) => {
        if (index === 0) return; // Skip the first option
        const div = document.createElement('div');
        div.textContent = option.text;
        div.dataset.value = option.value;
        dropdown.appendChild(div);
    });

    container.appendChild(wrapper);
    container.appendChild(dropdown);

    selectElement.style.display = 'none';
    selectElement.parentNode.insertBefore(container, selectElement);

    wrapper.addEventListener('click', () => {
        dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
        searchInput.focus();
    });

    searchInput.addEventListener('input', () => {
        const filter = searchInput.value.toLowerCase();
        Array.from(dropdown.children).forEach(child => {
            if (child.tagName === 'DIV') {
                child.style.display = child.textContent.toLowerCase().includes(filter) ? '' : 'none';
            }
        });
    });

    dropdown.addEventListener('click', (event) => {
        if (event.target.tagName === 'DIV') {
            selectElement.value = event.target.dataset.value;
            wrapper.innerHTML = event.target.textContent;
            dropdown.style.display = 'none';
            selectElement.dispatchEvent(new Event('change'));
        }
    });

    document.addEventListener('click', (event) => {
        if (!container.contains(event.target)) {
            dropdown.style.display = 'none';
        }
    });
}

/**
 * Handle validate button click
 */
async function handleValidateClick() {
    const ifcSelect = document.querySelector('select[name="ifc_filename"]');
    const idsSelect = document.querySelector('select[name="ids_filename"]');

    var documentIfcID = ifcSelect.value;
    var documentIdsID = idsSelect.value;
    var ifcFilename = ifcSelect.options[ifcSelect.selectedIndex].text;
    
    // Get metadata for cache keys from selected options
    const ifcOption = ifcSelect.options[ifcSelect.selectedIndex];
    const idsOption = idsSelect.options[idsSelect.selectedIndex];
    
    const ifcMeta = {
        documentId: documentIfcID,
        revisionId: ifcOption.dataset.revId || null,
        uploadDate: ifcOption.dataset.uploadDate || null
    };
    
    const idsMeta = {
        documentId: documentIdsID,
        revisionId: idsOption.dataset.revId || null,
        uploadDate: idsOption.dataset.uploadDate || null
    };

    // Disable the select elements while validating
    ifcSelect.disabled = true;
    idsSelect.disabled = true;

    // Clear the #report innerHTML
    document.getElementById('report').innerHTML = '';
    
    // Show a simple loading spinner
    const loadingIndicator = document.createElement('div');
    loadingIndicator.id = 'loading-indicator';
    loadingIndicator.innerHTML = `
        <div class="wasm-loading">
            <div class="spinner"></div>
            <div id="wasm-progress-text">Validating...</div>
        </div>
    `;
    document.querySelector('.file-selection-container').insertAdjacentElement('afterend', loadingIndicator);

    try {
        // Check if files are already being fetched from selection handlers
        const usePendingIfc = pendingIfcDownload && 
            selectedIfcMeta && 
            selectedIfcMeta.documentId === documentIfcID;
        const usePendingIds = pendingIdsDownload && 
            selectedIdsMeta && 
            selectedIdsMeta.documentId === documentIdsID;

        // Get IFC data - use pending download if available, otherwise fetch with caching
        let ifcData;
        if (usePendingIfc) {
            console.log('[IDS Widget] Using pending IFC download');
            ifcData = await pendingIfcDownload;
        }
        if (!ifcData) {
            const downloadlinkIfc = await StreamBIM.makeApiRequest({ 
                url: `${baseUrl}/project-${projectID}/api/v1/documents/${documentIfcID}/downloadlink` 
            });
            ifcData = await downloadFileWithCache(downloadlinkIfc, ifcMeta.documentId, ifcMeta.revisionId, ifcMeta.uploadDate);
        }
        console.log('[IDS Widget] IFC file ready:', ifcFilename, ifcData.byteLength, 'bytes');

        // Get IDS data - use pending download if available, otherwise fetch with caching
        let idsData;
        if (usePendingIds) {
            console.log('[IDS Widget] Using pending IDS download');
            idsData = await pendingIdsDownload;
        }
        if (!idsData) {
            const downloadlinkIds = await StreamBIM.makeApiRequest({ 
                url: `${baseUrl}/project-${projectID}/api/v1/documents/${documentIdsID}/downloadlink` 
            });
            idsData = await downloadFileWithCache(downloadlinkIds, idsMeta.documentId, idsMeta.revisionId, idsMeta.uploadDate);
        }
        console.log('[IDS Widget] IDS file ready:', idsData.byteLength, 'bytes');

        // Perform WASM-based validation
        const data = await validateWithWasm(ifcData, idsData);

        // Remove the loading indicator
        loadingIndicator.remove();
        ifcSelect.disabled = false;
        idsSelect.disabled = false;

        // Check if validation returned an error (e.g., schema mismatch)
        if (data && data.success === false && data.error) {
            console.error('[IDS Widget] Validation error:', data.error, 'type:', data.error_type);
            
            // Determine error title based on error type
            let errorTitle = 'Validation Error';
            if (data.error_type === 'ids_xml_validation') {
                errorTitle = 'Invalid IDS File';
            } else if (data.error_type === 'schema_mismatch') {
                // Use specific schema versions in title if available
                if (data.ids_schema && data.ifc_schema) {
                    errorTitle = `Schema Mismatch: IDS targets ${data.ids_schema}, model is ${data.ifc_schema}`;
                } else {
                    errorTitle = 'IFC Schema Mismatch';
                }
            }
            
            // Build a more informative error display
            let errorHtml = `<div class="error validation-error">
                <h3>${errorTitle}</h3>
                <p>${escapeHtml(data.error)}</p>`;
            
            // If we have a list of incompatible entities, show them
            if (data.incompatible_entities && data.incompatible_entities.length > 0) {
                errorHtml += `<details>
                    <summary>Incompatible entity types (${data.incompatible_entities.length})</summary>
                    <ul class="incompatible-entities-list">
                        ${data.incompatible_entities.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
                    </ul>
                </details>`;
            }
            
            errorHtml += `</div>`;
            document.getElementById("report").innerHTML = errorHtml;
            return;
        }

        if (typeof data === 'object' && data.report) {
            jsondata = JSON.parse(data.report);
            
            // Determine the template to use based on the document name
            let templateId = 'json-template-IDS';

            // Use the determined template
            const templateScript = document.getElementById(templateId).innerHTML;
            const template = Handlebars.compile(templateScript);
            const html = template(jsondata);

            document.getElementById("report").innerHTML = html;
            
            // Setup event handlers for expanding/collapsing details
            setupDetailHandlers();
        } else {
            console.log("Data received not in expected format:", data);
            document.getElementById("report").innerHTML = `<div class="error">Unexpected response format</div>`;
        }
    } catch (error) {
        console.error('[IDS Widget] Validation error:', error);
        
        // Update loading indicator to show error
        const loadingIndicator = document.getElementById('loading-indicator');
        if (loadingIndicator) {
            // Check if this is a fatal Pyodide error that requires reload
            const isFatalError = error.message && (
                error.message.includes('fatally failed') ||
                error.message.includes('fatal error') ||
                error.message.includes('can no longer be used')
            );
            
            if (isFatalError) {
                // Show reload prompt for fatal errors
                loadingIndicator.innerHTML = `
                    <div class="error">
                        <p>The validation engine encountered an error and needs to be restarted.</p>
                        <button onclick="location.reload()" class="reload-button">Reload Widget</button>
                    </div>`;
            } else {
                // Show the actual error message for recoverable errors
                loadingIndicator.innerHTML = `<div class="error">Validation failed: ${error.message}</div>`;
            }
        }
        
        ifcSelect.disabled = false;
        idsSelect.disabled = false;
    }
}

/**
 * Setup event handlers for expanding/collapsing requirement details
 */
function setupDetailHandlers() {
    document.addEventListener("click", function(event) {
        if (event.target.classList.contains("summary-toggle")) {
            var detailsElement = event.target.closest('details');
            var reqIndex = event.target.dataset.reqIndex;
            var specIndex = event.target.dataset.specIndex;
            
            var tableContainer = document.getElementById('table-container-' + specIndex + '-' + reqIndex);
            if (!tableContainer) return;
        
            if (detailsElement && detailsElement.hasAttribute('open')) {
                // If details are open, clear the content and close the details
                tableContainer.innerHTML = '';
                const loadMoreBtn = document.querySelector('.load-more[data-spec-index="' + specIndex + '"][data-req-index="' + reqIndex + '"]');
                if (loadMoreBtn) loadMoreBtn.style.display = 'none';
            } else {
                // If details are closed, load content
                var context = jsondata.specifications[specIndex]?.requirements[reqIndex];
                if (!context || !context.failed_entities) return;
                
                var templateScript = document.getElementById('json-template-IDS-requirement')?.innerHTML;
                if (!templateScript) return;
                
                var template = Handlebars.compile(templateScript);
                var initialRows = context.failed_entities.slice(0, 100);
                var html = template({failed_entities: initialRows});
                tableContainer.innerHTML = html;
        
                if (context.failed_entities.length > 100) {
                    const loadMoreBtn = document.querySelector('.load-more[data-spec-index="' + specIndex + '"][data-req-index="' + reqIndex + '"]');
                    if (loadMoreBtn) loadMoreBtn.style.display = 'block';
                }
            }
        }
    });
  
    document.addEventListener("click", function(event) {
        if (event.target.classList.contains("load-more")) {
            var reqIndex = event.target.dataset.reqIndex;
            var specIndex = event.target.dataset.specIndex;
            var context = jsondata.specifications[specIndex]?.requirements[reqIndex];
            if (!context || !context.failed_entities) return;
            
            var tableContainer = document.getElementById('table-container-' + specIndex + '-' + reqIndex);
            if (!tableContainer) return;
        
            // Determine the current count of loaded rows
            var currentCount = document.querySelectorAll('#table-container-' + specIndex + '-' + reqIndex + ' .row-class').length;
            // Slice the next 100 rows based on the currentCount
            var additionalRows = context.failed_entities.slice(currentCount, currentCount + 100);
            
            var templateScript = document.getElementById('json-template-IDS-requirement')?.innerHTML;
            if (!templateScript) return;
            
            var template = Handlebars.compile(templateScript);
            var html = template({failed_entities: additionalRows});
            tableContainer.insertAdjacentHTML('beforeend', html);
        
            // Hide 'Load More' button if all rows are loaded
            if (currentCount + 100 >= context.failed_entities.length) {
                event.target.style.display = 'none';
            }
        }
    });
}

/**
 * Escape HTML to prevent XSS when displaying user/external content
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Helper function to get the value of a given key in an array of objects
function getValue(properties, key) {
    const property = properties.find(property => property.key === key);
    return property && property.hasOwnProperty("value") ? property.value : "";
}

// Helper function to find the value of a given key in an object
function findKey(obj, key) {
    for (const prop in obj) {
        if (prop === key) {
            return obj[prop];
        } else if (typeof obj[prop] === 'object') {
            const result = findKey(obj[prop], key);
            if (result !== undefined) {
                return result;
            }
        }
    }
    return undefined;
}

// helper to go to object (IDS report)
function gotoObject(guid){
    StreamBIM.gotoObject(guid);
}

// helper to copy element tag to clipboard
function copyToClipboard($this) {
    var bimId = $this.dataset.tag;

    // Change the button to show only the BIM ID
    $this.title = 'Copied '+bimId;

    // Create a temporary text area to hold the value to be copied
    var tempTextArea = document.createElement('textarea');
    tempTextArea.value = bimId;
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    try {
        var successful = document.execCommand('copy');
        console.log('Copying text command was ' + (successful ? 'successful' : 'unsuccessful'));
    } catch (err) {
        console.error('Oops, unable to copy', err);
    }

    document.body.removeChild(tempTextArea);

    // Set a timeout to revert the button HTML content back to its original state after 2 seconds
    setTimeout(function() {
        $this.title = "Click to copy the ID. Use 'Select Elements by ID' in Revit";
    }, 2000);
}

// helper to copy element tags to clipboard
function copyToClipboardEntities($this, specIndex, reqIndex) {
    const failedEntities = jsondata.specifications[specIndex].requirements[reqIndex].failed_entities;

    let guids = new Set(failedEntities.map(entity => entity.tag));
    var bimId = Array.from(guids).join(',').toString();
    console.log(bimId);

    // Change the button to show only the BIM ID
    $this.title = 'Copied!';

    // Create a temporary text area to hold the value to be copied
    var tempTextArea = document.createElement('textarea');
    tempTextArea.value = bimId;
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    try {
        var successful = document.execCommand('copy');
        console.log('Copying text command was ' + (successful ? 'successful' : 'unsuccessful'));
    } catch (err) {
        console.error('Oops, unable to copy', err);
    }

    document.body.removeChild(tempTextArea);

    // Set a timeout to revert the button HTML content back to its original state after 2 seconds
    setTimeout(function() {
        $this.title = "Click to copy the ID. Use 'Select Elements by ID' in Revit";
    }, 2000);
}

// helper to highlight failed entities (IDS report)
function highlightFailedEntities(specIndex, reqIndex) {
    const failedEntities = jsondata.specifications[specIndex].requirements[reqIndex].failed_entities;

    let guids = new Set(failedEntities.map(entity => entity.global_id));

    // Create the query with rules based on the unique GUIDs
    let query = {
        rules: Array.from(guids).map(guid => ([{
            buildingId: "1000",
            propValue: guid,
            operator: "",
            propKey: "GUID"
        }]))
    };
    var pset = null;
    var propertyKey = "File Name";
    // Apply the search and visualization based on the GUIDs
    StreamBIM.applyObjectSearch(query).then((result) => {
        console.log(query);
        console.log(result);
        StreamBIM.colorCodeByProperty({pset, propertyKey}).then(() => {
            StreamBIM.setSearchVisualizationMode('hidden');
            StreamBIM.zoomToSearchResult();
        });
    }).catch((error) => {console.error(error)});
}

// helper to highlight individual object (clash reports)
function highlightObject(guid){
    StreamBIM.gotoObject(guid);
    var query = {
        key: "GUID",
        value: guid
    };

    var pset = null;
    var propertyKey = "Type";
    // Apply the search and visualization based on the GUIDs
    StreamBIM.applyObjectSearch(query).then(() => {
        StreamBIM.setSearchVisualizationMode('FADED');
        StreamBIM.zoomToSearchResult();
    }).catch((error) => {console.error(error)});
}

// helper to highlight grouped objects (clash reports)
function highlightGroup(index) {
    let guids = new Set();

    // Iterate over all clash types and their groups
    for (let clashType in jsondata) {
        if (jsondata.hasOwnProperty(clashType)) {
            jsondata[clashType].forEach(groupArray => {
                for (let group in groupArray) {
                    if (group === index) {
                        groupArray[group].forEach(pair => pair.forEach(guid => guids.add(guid)));
                    }
                }
            });
        }
    }

    // Create the query with rules based on the GUIDs
    let query = {
        rules: Array.from(guids).map(guid => ([{
            buildingId: "1000",
            propValue: guid,
            operator: "",
            propKey: "GUID"
        }]))
    };

    var pset = null;
    var propertyKey = "File Name";
    // Apply the search and visualization based on the GUIDs
    StreamBIM.applyObjectSearch(query).then(() => {
        StreamBIM.colorCodeByProperty({pset, propertyKey}).then(() => {
            StreamBIM.setSearchVisualizationMode('FADED');
            StreamBIM.zoomToSearchResult();
        });
    }).catch((error) => {console.error(error)});
}

// Handlebars helper functions
Handlebars.registerHelper('formatKey', function(key) {
    return key.split('.')[0];
});

Handlebars.registerHelper('anyTags', function(failedEntities, options) {
    // Check if any 'failed_entities' have a 'tag' property that's not empty or null
    const hasTags = failedEntities.some(entity => entity.tag);
    return hasTags ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('keyOfFirstProperty', function(context) {
    return Object.keys(context)[0];
});

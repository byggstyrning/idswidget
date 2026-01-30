/**
 * WASM Web Worker
 * Loads Pyodide and runs Python ifcopenshell/ifctester in the browser
 */

// Message types (duplicated from index.js since workers can't easily import from parent)
const MessageType = {
    INIT: 'init',
    API_CALL: 'api_call',
    READY: 'ready',
    API_RESPONSE: 'api_response',
    ERROR: 'error',
    PROGRESS: 'progress',
    DISPOSED: 'disposed'
};

// API module will be loaded dynamically
let API = null;

let pyodide = null;
let ready = false;
let CONFIG = null;

// Cache name for wheels - version is appended from config
const WHEEL_CACHE_PREFIX = 'ids-widget-wheels-';

/**
 * Get wheel data from cache or fetch from network
 * Uses Cache API for persistent browser storage
 */
async function getCachedOrFetchWheel(url, cacheVersion = 'v1') {
    const cacheName = `${WHEEL_CACHE_PREFIX}${cacheVersion}`;
    
    try {
        const cache = await caches.open(cacheName);
        const cached = await cache.match(url);
        
        if (cached) {
            console.log('[worker] Using cached wheel:', url);
            return cached.arrayBuffer();
        }
        
        console.log('[worker] Fetching wheel (not in cache):', url);
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch wheel: ${response.status} ${response.statusText}`);
        }
        
        // Clone response before consuming it (can only read body once)
        const responseClone = response.clone();
        
        // Store in cache for future use
        await cache.put(url, responseClone);
        console.log('[worker] Wheel cached:', url);
        
        return response.arrayBuffer();
    } catch (e) {
        // If cache fails (e.g., in private browsing), fall back to direct fetch
        console.warn('[worker] Cache API unavailable, fetching directly:', e.message);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch wheel: ${response.status} ${response.statusText}`);
        }
        return response.arrayBuffer();
    }
}

// Load configuration
async function loadConfig() {
    if (CONFIG) return CONFIG;
    
    try {
        const response = await fetch('/config.json');
        CONFIG = (await response.json()).wasm;
    } catch (e) {
        console.warn('[worker] Failed to load config.json, using defaults');
        // Default configuration
        CONFIG = {
            pyodide_url: 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/',
            wheel_url: 'https://github.com/AECgeeks/ifcopenshell-wasm/releases/download/v0.8.0/ifcopenshell-0.8.0-cp312-cp312-pyodide_2024_0_wasm32.whl',
            odfpy_url: 'https://files.pythonhosted.org/packages/py2.py3/o/odfpy/odfpy-1.4.2-py2.py3-none-any.whl'
        };
    }
    return CONFIG;
}

self.addEventListener('message', async (event) => {
    console.log("[worker] Received message:", event.data);
    const { type, payload, id } = event.data;

    try {
        switch (type) {
            case MessageType.INIT:
                await initEnvironment();
                self.postMessage({
                    type: MessageType.READY,
                    payload: { success: true },
                    id
                });
                break;

            case MessageType.API_CALL:
                if (!ready) {
                    throw new Error('[worker] Pyodide not initialized');
                }
                const result = await handleApiCall(payload);
                self.postMessage({
                    type: MessageType.API_RESPONSE,
                    payload: result,
                    id
                });
                break;

            default:
                throw new Error(`[worker] Unknown message type: ${type}`);
        }
    } catch (error) {
        self.postMessage({
            type: MessageType.ERROR,
            payload: {
                message: error.message,
                stack: error.stack
            },
            id
        });
    }
});

function sendProgress(message, percent = null) {
    self.postMessage({
        type: MessageType.PROGRESS,
        payload: { message, percent }
    });
}

async function initEnvironment() {
    if (ready) return;

    // Load configuration first
    await loadConfig();

    sendProgress('Loading Pyodide runtime...', 10);

    // Load Pyodide
    importScripts(`${CONFIG.pyodide_url}pyodide.js`);
    
    pyodide = await loadPyodide({
        indexURL: CONFIG.pyodide_url
    });

    sendProgress('Loading micropip package manager...', 30);

    // Load required packages
    await pyodide.loadPackage('micropip');
    
    sendProgress('Loading numpy...', 40);
    await pyodide.loadPackage('numpy');

    const micropip = pyodide.pyimport('micropip');

    sendProgress('Installing IfcOpenShell (this may take a moment)...', 50);
    
    // Install wheels from local server (downloaded during Docker build)
    // Config now contains local paths like /wheels/ifcopenshell-xxx.whl
    // Wheels are cached in browser using Cache API for faster repeat visits
    const origin = self.location.origin;
    const cacheVersion = CONFIG.cache_version || 'v1';
    
    try {
        // Build the full URL for the wheel (config has relative path like /wheels/...)
        const wheelUrl = CONFIG.wheel_url.startsWith('http') 
            ? CONFIG.wheel_url 
            : `${origin}${CONFIG.wheel_url}`;
        
        // Get wheel from cache or fetch (with automatic caching)
        const wheelData = await getCachedOrFetchWheel(wheelUrl, cacheVersion);
        console.log('[worker] ifcopenshell wheel ready:', wheelData.byteLength, 'bytes');
        
        // Extract wheel filename from URL
        const wheelFilename = CONFIG.wheel_url.split('/').pop();
        const wheelPath = `/tmp/${wheelFilename}`;
        
        // Write wheel to Pyodide's virtual filesystem
        pyodide.FS.writeFile(wheelPath, new Uint8Array(wheelData));
        console.log('[worker] Wheel saved to:', wheelPath);
        
        // Install from emfs:// path
        await micropip.install(`emfs:${wheelPath}`);
        console.log('[worker] ifcopenshell installed successfully');
    } catch (e) {
        console.error('[worker] Failed to install ifcopenshell wheel:', e);
        throw new Error('Failed to install ifcopenshell. PyPI does not have a Pyodide-compatible wheel.');
    }

    sendProgress('Installing ifctester dependencies...', 70);
    
    // Install odfpy from local wheel (PyPI doesn't have a pure Python wheel)
    try {
        const odfpyUrl = CONFIG.odfpy_url.startsWith('http')
            ? CONFIG.odfpy_url
            : `${origin}${CONFIG.odfpy_url}`;
        
        // Get wheel from cache or fetch (with automatic caching)
        const odfpyData = await getCachedOrFetchWheel(odfpyUrl, cacheVersion);
        console.log('[worker] odfpy wheel ready:', odfpyData.byteLength, 'bytes');
        
        // Extract wheel filename from URL
        const odfpyFilename = CONFIG.odfpy_url.split('/').pop();
        const odfpyPath = `/tmp/${odfpyFilename}`;
        
        // Write wheel to Pyodide's virtual filesystem
        pyodide.FS.writeFile(odfpyPath, new Uint8Array(odfpyData));
        console.log('[worker] odfpy wheel saved to:', odfpyPath);
        
        // Install from emfs:// path
        await micropip.install(`emfs:${odfpyPath}`);
        console.log('[worker] odfpy installed successfully');
    } catch (e) {
        console.warn('[worker] Failed to install odfpy:', e);
        // odfpy is optional, ifctester can work without it (just no ODF reports)
    }

    sendProgress('Installing ifctester...', 80);
    
    // Install ifctester
    await micropip.install('ifctester');

    sendProgress('Initializing API...', 90);
    
    // Initialize API module (inline since we can't import ES modules in classic workers)
    API = await initAPI(pyodide);

    sendProgress('Ready!', 100);
    console.log("[worker] Environment initialized");

    ready = true;
}

/**
 * Initialize the API module inline
 */
async function initAPI(pyodide) {
    let messageId = 0;
    const LoadedIFC = new Map();

    function generateId() {
        return `ifc_${++messageId}_${Date.now()}`;
    }

    // Pre-import the modules we'll need
    await pyodide.runPythonAsync(`
import ifcopenshell
from ifctester import ids, reporter
import json
    `);

    console.log("[api] API initialized with ifcopenshell and ifctester");

    return {
        async cleanup() {
            for (const [ifcId, _] of LoadedIFC) {
                try {
                    const path = `/tmp/${encodeURIComponent(ifcId)}.ifc`;
                    pyodide.FS.unlink(path);
                } catch (e) {
                    console.warn("[api] Failed to cleanup file:", e);
                }
            }
            LoadedIFC.clear();
            console.log("[api] Cleanup complete");
        },

        async loadIfc(ifcData) {
            const ifcId = generateId();
            const path = `/tmp/${encodeURIComponent(ifcId)}.ifc`;

            pyodide.FS.writeFile(path, new Uint8Array(ifcData));

            // Load IFC and get schema info
            const result = await pyodide.runPythonAsync(`
import json
import ifcopenshell
ifc = ifcopenshell.open("${path}")
json.dumps({"schema": ifc.schema})
            `);
            
            const parsed = JSON.parse(result);
            const ifcSchema = parsed.schema;

            LoadedIFC.set(ifcId, { schema: ifcSchema });
            console.log("[api] Loaded IFC file:", ifcId, "schema:", ifcSchema);
            
            return { ifcId, schema: ifcSchema };
        },

        async unloadIfc(ifcId) {
            const path = `/tmp/${encodeURIComponent(ifcId)}.ifc`;

            try {
                pyodide.FS.unlink(path);
            } catch (e) {
                console.warn("[api] File already removed:", e);
            }
            
            LoadedIFC.delete(ifcId);
            console.log("[api] Unloaded IFC file:", ifcId);
        },

        async auditIfc(ifcId, idsData) {
            const ifcInfo = LoadedIFC.get(ifcId);
            
            if (!ifcInfo) {
                throw new Error(`IFC file not found: ${ifcId}`);
            }

            const idsString = new TextDecoder().decode(new Uint8Array(idsData));
            const idsPath = `/tmp/${encodeURIComponent(ifcId)}.ids`;
            pyodide.FS.writeFile(idsPath, idsString);

            // Run validation
            const result = await pyodide.runPythonAsync(`
import json
from ifctester import ids, reporter
import ifcopenshell

result = None
ifc_path = "/tmp/${encodeURIComponent(ifcId)}.ifc"
ids_path = "${idsPath}"

try:
    my_ifc = ifcopenshell.open(ifc_path)
    my_ids = ids.open(ids_path)
    
    my_ids.validate(my_ifc)
    
    json_reporter = reporter.Json(my_ids)
    json_reporter.report()
    json_report = json_reporter.to_string()
    
    total_specs = len(my_ids.specifications)
    passed_specs = sum(1 for spec in my_ids.specifications if spec.status)
    failed_specs = total_specs - passed_specs
    
    result = {
        "success": True,
        "total_specifications": total_specs,
        "passed_specifications": passed_specs,
        "failed_specifications": failed_specs,
        "report": json_report
    }
except Exception as e:
    error_msg = str(e)
    result = {
        "success": False,
        "error": f"Validation error: {error_msg}",
        "total_specifications": 0,
        "passed_specifications": 0,
        "failed_specifications": 0,
        "report": None
    }

json.dumps(result)
            `);

            try {
                pyodide.FS.unlink(idsPath);
            } catch (e) {
                console.warn("[api] Failed to cleanup IDS file:", e);
            }

            const parsed = JSON.parse(result);
            
            if (!parsed.success) {
                console.error("[api] Validation error:", parsed.error);
                throw new Error(parsed.error);
            }
            
            console.log("[api] Validation complete:", {
                total: parsed.total_specifications,
                passed: parsed.passed_specifications,
                failed: parsed.failed_specifications
            });

            return parsed;
        }
    };
}

async function cleanupEnvironment() {
    if (API) {
        await API.cleanup();
    }
    ready = false;
    pyodide = null;
    API = null;
    console.log("[worker] Closed environment");
}

async function handleApiCall({ method, args = [] }) {
    if (method === 'cleanup') {
        await cleanupEnvironment();
        return true;
    }

    if (API && typeof API[method] === 'function') {
        return await API[method](...args);
    } else {
        throw new Error(`[worker] Unknown API method: ${method}`);
    }
}

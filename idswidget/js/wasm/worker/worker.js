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
    
    // Install IfcOpenShell wheel
    try {
        await micropip.install(CONFIG.wheel_url);
    } catch (e) {
        console.warn('[worker] Failed to install wheel from URL, trying PyPI...', e);
        // Fallback to PyPI if the wheel URL fails
        await micropip.install('ifcopenshell');
    }

    sendProgress('Installing ifctester dependencies...', 70);
    
    // Install odfpy (required by ifctester)
    try {
        await micropip.install(CONFIG.odfpy_url);
    } catch (e) {
        console.warn('[worker] Failed to install odfpy from URL, trying PyPI...', e);
        await micropip.install('odfpy');
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

            const ifc = await pyodide.runPythonAsync(`
import ifcopenshell
ifc = ifcopenshell.open("${path}")
ifc
            `);

            LoadedIFC.set(ifcId, ifc);
            console.log("[api] Loaded IFC file:", ifcId);
            
            return ifcId;
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
            const ifc = LoadedIFC.get(ifcId);
            
            if (!ifc) {
                throw new Error(`IFC file not found: ${ifcId}`);
            }

            const idsString = new TextDecoder().decode(new Uint8Array(idsData));
            const idsPath = `/tmp/${encodeURIComponent(ifcId)}.ids`;
            pyodide.FS.writeFile(idsPath, idsString);

            const result = await pyodide.runPythonAsync(`
import json
from ifctester import ids, reporter

my_ids = ids.open("${idsPath}")

import ifcopenshell
ifc_path = "/tmp/${encodeURIComponent(ifcId)}.ifc"
my_ifc = ifcopenshell.open(ifc_path)

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

json.dumps(result)
            `);

            try {
                pyodide.FS.unlink(idsPath);
            } catch (e) {
                console.warn("[api] Failed to cleanup IDS file:", e);
            }

            const parsed = JSON.parse(result);
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

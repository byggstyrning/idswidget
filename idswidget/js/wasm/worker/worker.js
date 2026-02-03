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

        /**
         * Validate an IDS file structure without needing an IFC file
         * Checks XML schema validity and extracts entity types for compatibility info
         */
        async validateIds(idsData) {
            const idsString = new TextDecoder().decode(new Uint8Array(idsData));
            const idsPath = `/tmp/validate_ids_${Date.now()}.ids`;
            pyodide.FS.writeFile(idsPath, idsString);

            const result = await pyodide.runPythonAsync(`
import json
from ifctester import ids
import xml.etree.ElementTree as ET

result = None
ids_path = "${idsPath}"

def extract_entity_types(ids_xml_content):
    """Extract all entity types referenced in the IDS file."""
    entity_types = set()
    
    try:
        root = ET.fromstring(ids_xml_content)
    except ET.ParseError:
        return []
    
    # Find all entity elements
    for elem in root.iter():
        if elem.tag.endswith('entity') or elem.tag == 'entity':
            for child in elem:
                tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                if tag == 'name':
                    for name_child in child:
                        name_tag = name_child.tag.split('}')[-1] if '}' in name_child.tag else name_child.tag
                        if name_tag == 'simpleValue' and name_child.text:
                            entity_types.add(name_child.text.strip().upper())
                        elif name_tag == 'restriction':
                            for enum_elem in name_child:
                                enum_tag = enum_elem.tag.split('}')[-1] if '}' in enum_elem.tag else enum_elem.tag
                                if enum_tag == 'enumeration':
                                    value = enum_elem.get('value')
                                    if value:
                                        entity_types.add(value.strip().upper())
    
    return sorted(list(entity_types))

try:
    # Read IDS content
    with open(ids_path, 'r', encoding='utf-8') as f:
        ids_content = f.read()
    
    # Step 1: Validate IDS XML structure against XSD schema
    try:
        my_ids = ids.open(ids_path, validate=True)
        
        # Extract metadata
        specs_count = len(my_ids.specifications)
        ifc_versions = set()
        for spec in my_ids.specifications:
            if hasattr(spec, 'ifcVersion'):
                ifc_versions.update(spec.ifcVersion)
        
        # Extract entity types for compatibility checking
        entity_types = extract_entity_types(ids_content)
        
        result = {
            "success": True,
            "valid": True,
            "specifications_count": specs_count,
            "ifc_versions": sorted(list(ifc_versions)),
            "entity_types": entity_types,
            "info": my_ids.info if hasattr(my_ids, 'info') else {}
        }
    except ids.IdsXmlValidationError as xml_err:
        result = {
            "success": True,
            "valid": False,
            "error": f"Invalid IDS file structure: {str(xml_err)}",
            "error_type": "xml_validation"
        }
    except Exception as parse_err:
        result = {
            "success": True,
            "valid": False,
            "error": f"Failed to parse IDS file: {str(parse_err)}",
            "error_type": "parse_error"
        }
except Exception as e:
    import traceback
    result = {
        "success": False,
        "error": f"IDS validation error: {str(e)}",
        "traceback": traceback.format_exc()
    }

# Cleanup
try:
    import os
    os.remove(ids_path)
except:
    pass

json.dumps(result)
            `);

            const parsed = JSON.parse(result);
            console.log("[api] IDS validation result:", parsed);
            return parsed;
        },

        /**
         * Check if entity types exist in a given IFC schema
         * Uses type_map for safe lookup without C++ exceptions
         */
        async checkEntityTypes(ifcSchema, entityTypes) {
            const entityTypesJson = JSON.stringify(entityTypes);
            
            const result = await pyodide.runPythonAsync(`
import json
import ifcopenshell.util.schema

entity_types = json.loads('${entityTypesJson}')
ifc_schema = "${ifcSchema}"

incompatible = []
try:
    # Use util.schema which has safer lookups via type maps
    schema_obj = ifcopenshell.ifcopenshell_wrapper.schema_by_name(ifc_schema)
    
    # Get all declarations as a set for O(1) lookup
    all_declarations = set()
    for decl in schema_obj.declarations():
        all_declarations.add(decl.name().upper())
    
    for entity_name in entity_types:
        if entity_name.upper() not in all_declarations:
            incompatible.append(entity_name)
except Exception as e:
    print(f"Schema check error: {e}")
    pass  # If schema lookup fails, return empty list

json.dumps({"incompatible": incompatible})
            `);

            const parsed = JSON.parse(result);
            console.log("[api] Entity type compatibility check:", parsed);
            return parsed;
        },

        async auditIfc(ifcId, idsData) {
            const ifcInfo = LoadedIFC.get(ifcId);
            
            if (!ifcInfo) {
                throw new Error(`IFC file not found: ${ifcId}`);
            }

            const idsString = new TextDecoder().decode(new Uint8Array(idsData));
            const idsPath = `/tmp/${encodeURIComponent(ifcId)}.ids`;
            pyodide.FS.writeFile(idsPath, idsString);

            // Run validation with schema compatibility checking
            const result = await pyodide.runPythonAsync(`
import json
from ifctester import ids, reporter
import ifcopenshell
import ifcopenshell.util.schema
import xml.etree.ElementTree as ET
import re

result = None
ifc_path = "/tmp/${encodeURIComponent(ifcId)}.ifc"
ids_path = "${idsPath}"

def check_ids_schema_compatibility(ids_xml_content, ifc_schema):
    """
    Check if all entity types referenced in the IDS file exist in the IFC schema.
    Returns a list of incompatible entity types.
    """
    incompatible_entities = []
    schema_obj = ifcopenshell.ifcopenshell_wrapper.schema_by_name(ifc_schema)
    
    # Parse the IDS XML
    try:
        root = ET.fromstring(ids_xml_content)
    except ET.ParseError:
        return []  # Let the IDS parser handle XML errors
    
    # Find all entity facets - handle both namespaced and non-namespaced XML
    namespaces = {
        'ids': 'http://standards.buildingsmart.org/IDS',
        'xs': 'http://www.w3.org/2001/XMLSchema'
    }
    
    # Try namespaced first
    entity_elements = root.findall('.//ids:entity', namespaces)
    if not entity_elements:
        # Fall back to searching without namespace
        entity_elements = root.findall('.//{*}entity')
    if not entity_elements:
        # Try direct search for 'entity' elements
        entity_elements = []
        for elem in root.iter():
            if elem.tag.endswith('entity') or elem.tag == 'entity':
                entity_elements.append(elem)
    
    for entity_elem in entity_elements:
        # Get the name element (could be simpleValue, restriction with enumeration, etc.)
        name_elem = None
        for child in entity_elem:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 'name':
                name_elem = child
                break
        
        if name_elem is None:
            continue
            
        # Extract entity type name(s) from the name element
        entity_names = []
        
        # Check for simpleValue child
        for child in name_elem:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 'simpleValue':
                if child.text:
                    entity_names.append(child.text.strip().upper())
            elif tag == 'restriction':
                # Handle xs:restriction with enumeration values
                for enum_elem in child:
                    enum_tag = enum_elem.tag.split('}')[-1] if '}' in enum_elem.tag else enum_elem.tag
                    if enum_tag == 'enumeration':
                        value = enum_elem.get('value')
                        if value:
                            entity_names.append(value.strip().upper())
        
        # Check each entity name against the schema
        for entity_name in entity_names:
            try:
                schema_obj.declaration_by_name(entity_name)
            except RuntimeError:
                incompatible_entities.append(entity_name)
    
    return list(set(incompatible_entities))  # Remove duplicates

try:
    # Step 1: Validate the IDS file structure against the XSD schema (no IFC needed)
    # This catches malformed IDS files early with clear error messages
    try:
        my_ids = ids.open(ids_path, validate=True)
    except ids.IdsXmlValidationError as xml_err:
        # IDS file doesn't conform to the XSD schema
        result = {
            "success": False,
            "error": f"Invalid IDS file: {str(xml_err)}",
            "error_type": "ids_xml_validation",
            "total_specifications": 0,
            "passed_specifications": 0,
            "failed_specifications": 0,
            "report": None
        }
        raise StopIteration()  # Use to exit the try block early
    
    # Step 2: Load the IFC file and get its schema
    my_ifc = ifcopenshell.open(ifc_path)
    ifc_schema = my_ifc.schema
    
    # Step 3: Read IDS content for entity type compatibility check
    with open(ids_path, 'r', encoding='utf-8') as f:
        ids_content = f.read()
    
    # Step 4: Check if entity types in IDS exist in the IFC schema
    incompatible = check_ids_schema_compatibility(ids_content, ifc_schema)
    
    if incompatible:
        # Return a user-friendly error about schema mismatch
        entity_list = ', '.join(sorted(incompatible)[:10])  # Show first 10
        more_count = len(incompatible) - 10 if len(incompatible) > 10 else 0
        more_text = f' and {more_count} more' if more_count > 0 else ''
        result = {
            "success": False,
            "error": f"Schema mismatch: The IDS file references entity types that don't exist in {ifc_schema}: {entity_list}{more_text}. The IDS may be designed for a newer IFC version (e.g., IFC4).",
            "error_type": "schema_mismatch",
            "total_specifications": 0,
            "passed_specifications": 0,
            "failed_specifications": 0,
            "report": None,
            "incompatible_entities": incompatible
        }
    else:
        # Step 5: Run full IFC validation against IDS
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
except StopIteration:
    pass  # Result already set in the IDS validation block
except Exception as e:
    import traceback
    error_msg = str(e)
    tb = traceback.format_exc()
    
    # Try to extract meaningful error message
    if "not found in schema" in error_msg.lower():
        # Extract entity name from error message
        match = re.search(r"Entity with name '([^']+)' not found in schema '([^']+)'", error_msg, re.IGNORECASE)
        if match:
            entity_name, schema_name = match.groups()
            error_msg = f"Schema mismatch: The entity type '{entity_name}' does not exist in {schema_name}. The IDS may be designed for a newer IFC version."
    
    result = {
        "success": False,
        "error": f"Validation error: {error_msg}",
        "error_type": "validation_error",
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

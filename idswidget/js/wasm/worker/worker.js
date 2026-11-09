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
            odfpy_url: 'https://files.pythonhosted.org/packages/py2.py3/o/odfpy/odfpy-1.4.2-py2.py3-none-any.whl',
            ifctester_version: '0.8.2'
        };
    }
    return CONFIG;
}

// WebAssembly memory is capped at 4 GB per worker, whatever the machine has
const OUT_OF_MEMORY_MESSAGE = 'Out of memory: the model is too large to validate in the browser ' +
    '(WebAssembly is limited to 4 GB). Reload the widget before validating again.';
const OUT_OF_MEMORY_PATTERN = /MemoryError|out of memory|Aborted\(OOM\)|Cannot enlarge memory|Array buffer allocation failed|bad_alloc/i;

self.addEventListener('message', async (event) => {
    const { type, payload, id } = event.data;
    // Log the method only: logging the payload keeps large IFC buffers alive
    console.log("[worker] Received message:", type, payload && payload.method);

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
        const isOutOfMemory = OUT_OF_MEMORY_PATTERN.test(String(error && error.message));
        self.postMessage({
            type: MessageType.ERROR,
            payload: {
                message: isOutOfMemory ? OUT_OF_MEMORY_MESSAGE : error.message,
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
    
    // Install ifctester pinned to the ifcopenshell wheel version.
    // Unpinned installs pick up newer releases (e.g. 0.9.0 imports sqlite3,
    // which Pyodide doesn't ship by default) and break validation.
    const ifctesterSpec = CONFIG.ifctester_version
        ? `ifctester==${CONFIG.ifctester_version}`
        : 'ifctester';
    await micropip.install(ifctesterSpec);
    console.log('[worker] Installed', ifctesterSpec);

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

    // Lets Python report validation progress to the UI
    pyodide.globals.set('_report_progress', (message, percent) => sendProgress(message, percent));

    // Shared Python helpers. Parsed models live in _models so each IFC is
    // parsed once (loadIfc) and reused by auditIfc.
    await pyodide.runPythonAsync(`
import gc
import json
import os
import ifcopenshell
import ifcopenshell.util.element
from ifctester import ids, reporter
from ifctester.facet import get_pset, get_psets

_models = {}


def _load_model(ifc_id, path):
    try:
        model = ifcopenshell.open(path)
    finally:
        # The parsed model no longer needs the file; free the in-memory copy
        os.remove(path)
    _models[ifc_id] = model
    return model.schema


def _unload_model(ifc_id):
    _models.pop(ifc_id, None)
    gc.collect()


def _validate_with_progress(ids_obj, model):
    # Same steps as Ids.validate() in ifctester 0.8.2, one specification at a time
    ids_obj.filepath = ids_obj.filename = None
    get_pset.cache_clear()
    get_psets.cache_clear()
    specs = ids_obj.specifications
    for i, spec in enumerate(specs):
        _report_progress(f"Checking specification {i + 1} of {len(specs)}: {spec.name}", round(100 * i / len(specs)))
        spec.reset_status()
        spec.check_ifc_version(model)
        spec.validate(model, should_filter_version=False)


class CompactJson(reporter.Json):
    """
    reporter.Json without passed entities, with failures stored column-wise
    (class, predefined type and reason as indexes into shared lookup tables).
    Large models produce hundreds of thousands of failures, and one dict per
    failure plus every passed entity made the report larger than the model.
    """

    def __init__(self, ids_obj):
        super().__init__(ids_obj)
        self._lookups = {"class": {}, "predefined_type": {}, "reason": {}}

    def _index(self, table, value):
        lookup = self._lookups[table]
        if value not in lookup:
            lookup[value] = len(lookup)
        return lookup[value]

    def report_passed_entities(self, requirement):
        requirement.passed_entities.clear()
        return []

    def report_failed_entities(self, requirement):
        failed = {"global_id": [], "tag": [], "name": [], "class": [], "predefined_type": [], "reason": []}
        for failure in requirement.failures:
            element = failure["element"]
            failed["global_id"].append(getattr(element, "GlobalId", None))
            failed["tag"].append(getattr(element, "Tag", None))
            failed["name"].append(getattr(element, "Name", None))
            failed["class"].append(self._index("class", element.is_a()))
            failed["predefined_type"].append(
                self._index("predefined_type", ifcopenshell.util.element.get_predefined_type(element))
            )
            failed["reason"].append(self._index("reason", failure["reason"]))
        requirement.failures.clear()
        return failed

    def report(self):
        results = super().report()
        for spec_report in results["specifications"]:
            for req_report in spec_report["requirements"]:
                req_report.pop("passed_entities", None)
                req_report["failed"] = req_report.pop("failed_entities")
                req_report["has_tags"] = any(req_report["failed"]["tag"])
        results["lookups"] = {table: list(lookup) for table, lookup in self._lookups.items()}
        # Drop remaining element references so the model can be freed
        for spec in self.ids.specifications:
            spec.applicable_entities.clear()
            spec.passed_entities.clear()
            spec.failed_entities.clear()
        return results
    `);

    console.log("[api] API initialized with ifcopenshell and ifctester");

    return {
        async cleanup() {
            for (const ifcId of LoadedIFC.keys()) {
                await pyodide.runPythonAsync(`_unload_model(${JSON.stringify(ifcId)})`);
            }
            LoadedIFC.clear();
            console.log("[api] Cleanup complete");
        },

        async loadIfc(ifcData) {
            const ifcId = generateId();
            const path = `/tmp/${encodeURIComponent(ifcId)}.ifc`;
            const sizeMb = Math.round(ifcData.byteLength / 1e6);

            // canOwn: the filesystem keeps this buffer instead of copying it
            pyodide.FS.writeFile(path, new Uint8Array(ifcData), { canOwn: true });

            sendProgress(`Reading IFC model (${sizeMb} MB)...`);
            const ifcSchema = await pyodide.runPythonAsync(
                `_load_model(${JSON.stringify(ifcId)}, ${JSON.stringify(path)})`
            );

            LoadedIFC.set(ifcId, { schema: ifcSchema });
            console.log("[api] Loaded IFC file:", ifcId, "schema:", ifcSchema, `${sizeMb} MB`);

            return { ifcId, schema: ifcSchema };
        },

        async unloadIfc(ifcId) {
            await pyodide.runPythonAsync(`_unload_model(${JSON.stringify(ifcId)})`);
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
            if (!LoadedIFC.has(ifcId)) {
                throw new Error(`IFC file not found: ${ifcId}`);
            }

            const idsString = new TextDecoder().decode(new Uint8Array(idsData));
            const idsPath = `/tmp/${encodeURIComponent(ifcId)}.ids`;
            pyodide.FS.writeFile(idsPath, idsString);

            // Run validation with schema compatibility checking.
            // The report string is left in _last_report rather than embedded in
            // the result JSON, so a large report isn't escaped and parsed twice.
            const result = await pyodide.runPythonAsync(`
import xml.etree.ElementTree as ET
import re

result = None
_last_report = None
ifc_id = ${JSON.stringify(ifcId)}
ids_path = ${JSON.stringify(idsPath)}

def check_ids_schema_compatibility(ids_xml_content, ifc_schema):
    """
    Check if all entity types referenced in the IDS file exist in the IFC schema.
    Returns a list of incompatible entity types.
    """
    incompatible_entities = []
    schema_obj = ifcopenshell.ifcopenshell_wrapper.schema_by_name(ifc_schema)

    try:
        root = ET.fromstring(ids_xml_content)
    except ET.ParseError:
        return []  # Let the IDS parser handle XML errors

    entity_elements = [elem for elem in root.iter() if elem.tag.endswith('entity')]

    for entity_elem in entity_elements:
        name_elem = None
        for child in entity_elem:
            tag = child.tag.split('}')[-1]
            if tag == 'name':
                name_elem = child
                break

        if name_elem is None:
            continue

        entity_names = []
        for child in name_elem:
            tag = child.tag.split('}')[-1]
            if tag == 'simpleValue':
                if child.text:
                    entity_names.append(child.text.strip().upper())
            elif tag == 'restriction':
                for enum_elem in child:
                    if enum_elem.tag.split('}')[-1] == 'enumeration':
                        value = enum_elem.get('value')
                        if value:
                            entity_names.append(value.strip().upper())

        for entity_name in entity_names:
            try:
                schema_obj.declaration_by_name(entity_name)
            except RuntimeError:
                incompatible_entities.append(entity_name)

    return list(set(incompatible_entities))

def _failure(error, error_type, **extra):
    return {
        "success": False,
        "error": error,
        "error_type": error_type,
        "total_specifications": 0,
        "passed_specifications": 0,
        "failed_specifications": 0,
        "report": None,
        **extra,
    }

try:
    # Step 1: Validate the IDS file structure against the XSD schema
    try:
        my_ids = ids.open(ids_path, validate=True)
    except ids.IdsXmlValidationError as xml_err:
        result = _failure(f"Invalid IDS file: {str(xml_err)}", "ids_xml_validation")
        raise StopIteration()

    # Step 2: Take the model parsed by loadIfc; it's freed once the report is built
    my_ifc = _models.pop(ifc_id)
    ifc_schema = my_ifc.schema

    # Step 3: Check if entity types in IDS exist in the IFC schema
    with open(ids_path, 'r', encoding='utf-8') as f:
        ids_content = f.read()
    incompatible = check_ids_schema_compatibility(ids_content, ifc_schema)

    if incompatible:
        entity_list = ', '.join(sorted(incompatible)[:10])
        more_count = len(incompatible) - 10 if len(incompatible) > 10 else 0
        more_text = f' and {more_count} more' if more_count > 0 else ''
        result = _failure(
            f"Schema mismatch: The IDS file references entity types that don't exist in {ifc_schema}: {entity_list}{more_text}. The IDS may be designed for a newer IFC version (e.g., IFC4).",
            "schema_mismatch",
            incompatible_entities=incompatible,
        )
    else:
        # Step 4: Validate, then build the compact report
        _validate_with_progress(my_ids, my_ifc)
        _report_progress("Building report...", 100)
        compact = CompactJson(my_ids)
        report_data = compact.report()

        total_specs = len(my_ids.specifications)
        passed_specs = sum(1 for spec in my_ids.specifications if spec.status)

        # Free the model before serialising the report
        del compact, my_ifc
        gc.collect()
        _last_report = json.dumps(report_data, default=reporter.Json.encode)
        del report_data

        result = {
            "success": True,
            "total_specifications": total_specs,
            "passed_specifications": passed_specs,
            "failed_specifications": total_specs - passed_specs,
            "report": None
        }
except StopIteration:
    pass  # Result already set in the IDS validation block
except MemoryError:
    result = _failure("OUT_OF_MEMORY", "out_of_memory")
except Exception as e:
    error_msg = str(e)

    if "not found in schema" in error_msg.lower():
        match = re.search(r"Entity with name '([^']+)' not found in schema '([^']+)'", error_msg, re.IGNORECASE)
        if match:
            entity_name, schema_name = match.groups()
            error_msg = f"Schema mismatch: The entity type '{entity_name}' does not exist in {schema_name}. The IDS may be designed for a newer IFC version."

    result = _failure(f"Validation error: {error_msg}", "validation_error")
finally:
    _models.pop(ifc_id, None)
    gc.collect()

json.dumps(result)
            `);

            LoadedIFC.delete(ifcId);
            try {
                pyodide.FS.unlink(idsPath);
            } catch (e) {
                console.warn("[api] Failed to cleanup IDS file:", e);
            }

            const parsed = JSON.parse(result);

            if (!parsed.success) {
                console.error("[api] Validation error:", parsed.error);
                throw new Error(parsed.error === 'OUT_OF_MEMORY' ? OUT_OF_MEMORY_MESSAGE : parsed.error);
            }

            parsed.report = pyodide.globals.get('_last_report');
            pyodide.globals.set('_last_report', null);

            console.log("[api] Validation complete:", {
                total: parsed.total_specifications,
                passed: parsed.passed_specifications,
                failed: parsed.failed_specifications,
                reportMb: (parsed.report.length / 1e6).toFixed(1)
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

/**
 * IDS Widget - WASM-based IFC/IDS Validation for StreamBIM
 * Uses Pyodide (Python in WASM) to run ifcopenshell/ifctester in the browser
 */

import wasm from './wasm/index.js';

var jsondata = '';
var projectID = '';
var wasmInitialized = false;
var wasmInitializing = false;

/**
 * Initialize the WASM module with progress feedback
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
    
    const loadingIndicator = document.getElementById('loading-indicator');
    const progressBar = document.getElementById('wasm-progress');
    const progressText = document.getElementById('wasm-progress-text');

    try {
        await wasm.init((progress) => {
            console.log('[WASM Progress]', progress.message, progress.percent);
            if (progressText) {
                progressText.textContent = progress.message || 'Initializing...';
            }
            if (progressBar && progress.percent !== null) {
                progressBar.style.width = `${progress.percent}%`;
            }
        });
        
        wasmInitialized = true;
        console.log('[IDS Widget] WASM module initialized');
        return true;
    } catch (error) {
        console.error('[IDS Widget] Failed to initialize WASM:', error);
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
 */
async function downloadFile(downloadLink) {
    const fullUrl = `https://app.streambim.com/project-${projectID}/api/v1/${downloadLink}`;
    
    // Use StreamBIM API to make the request (handles authentication)
    const response = await fetch(fullUrl, {
        credentials: 'include'
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
    
    // Load IFC file
    const ifcId = await wasm.loadIfc(ifcData);
    console.log('[IDS Widget] IFC loaded with ID:', ifcId);
    
    try {
        // Run validation
        const result = await wasm.auditIfc(ifcId, idsData);
        console.log('[IDS Widget] Validation complete:', result);
        return result;
    } finally {
        // Cleanup: unload the IFC file
        await wasm.unloadIfc(ifcId);
    }
}

document.addEventListener('DOMContentLoaded', function() {
    console.log("IDS Widget loaded (WASM version)");

    StreamBIM.connect().then(function () {
        console.log("StreamBIM connected");
        StreamBIM.setStyles(".color-code-values--left-sliders-active {margin-left: 40%;}");
        
        StreamBIM.getProjectId().then((result) => {
            projectID = result;
            const queryIds = { filter: { freetext: ".ids", isDeleted: false } };
            const base64queryIds = btoa(JSON.stringify(queryIds));
            
            StreamBIM.makeApiRequest({url: `https://app.streambim.com/project-${projectID}/api/v1/documents/export/json/?query=${base64queryIds}`})
            .then(response => JSON.parse(response))
            .then(idsDocuments => populateSelectElement(idsDocuments, 'ids_filename'))
            .then(() => {
                const idsSelect = document.querySelector('select[name="ids_filename"]');
                idsSelect.disabled = false;
                idsSelect.options[0].text = "Select IDS file for Validation...";
                createSearchableSelect(idsSelect);
            })
            .catch(error => console.error("Error fetching ids documents:", error));

            const queryIfc = { filter: { freetext: ".ifc", isDeleted: false } };
            const base64queryIfc = btoa(JSON.stringify(queryIfc));
            
            StreamBIM.makeApiRequest({url: `https://app.streambim.com/project-${projectID}/api/v1/documents/export/json/?query=${base64queryIfc}`})
            .then(response => JSON.parse(response))
            .then(ifcDocuments => populateSelectElement(ifcDocuments, 'ifc_filename'))
            .then(() => {
                const ifcSelect = document.querySelector('select[name="ifc_filename"]');
                ifcSelect.disabled = false;
                ifcSelect.options[0].text = "Select IFC file for Validation...";
                createSearchableSelect(ifcSelect);
            })
            .catch(error => console.error("Error fetching documents:", error));

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
            
        }).catch((error) => console.error(error));
    }).catch((error) => console.error(error));
});

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

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('validate').addEventListener('click', async function() {
        const ifcSelect = document.querySelector('select[name="ifc_filename"]');
        const idsSelect = document.querySelector('select[name="ids_filename"]');

        var documentIfcID = ifcSelect.value;
        var documentIdsID = idsSelect.value;
        var ifcFilename = ifcSelect.options[ifcSelect.selectedIndex].text;

        // Disable the select elements while validating
        ifcSelect.disabled = true;
        idsSelect.disabled = true;

        // Clear the #report innerHTML
        document.getElementById('report').innerHTML = '';
        
        // Show a loading indicator with progress
        const loadingIndicator = document.createElement('div');
        loadingIndicator.id = 'loading-indicator';
        loadingIndicator.innerHTML = `
            <div class="wasm-loading">
                <div id="wasm-progress-text">Preparing validation...</div>
                <div class="progress-container">
                    <div id="wasm-progress" class="progress-bar"></div>
                </div>
            </div>
        `;
        document.querySelector('.file-selection-container').insertAdjacentElement('afterend', loadingIndicator);

        try {
            // Get download links from StreamBIM
            const downloadlinkIfc = await StreamBIM.makeApiRequest({ 
                url: `https://app.streambim.com/project-${projectID}/api/v1/documents/${documentIfcID}/downloadlink` 
            });
            const downloadlinkIds = await StreamBIM.makeApiRequest({ 
                url: `https://app.streambim.com/project-${projectID}/api/v1/documents/${documentIdsID}/downloadlink` 
            });

            // Update progress
            document.getElementById('wasm-progress-text').textContent = 'Downloading IFC file...';
            document.getElementById('wasm-progress').style.width = '5%';

            // Download files
            const ifcData = await downloadFile(downloadlinkIfc);
            console.log('[IDS Widget] IFC file downloaded:', ifcFilename, ifcData.byteLength, 'bytes');
            
            document.getElementById('wasm-progress-text').textContent = 'Downloading IDS file...';
            document.getElementById('wasm-progress').style.width = '10%';

            const idsData = await downloadFile(downloadlinkIds);
            console.log('[IDS Widget] IDS file downloaded:', idsData.byteLength, 'bytes');

            // Perform WASM-based validation
            const data = await validateWithWasm(ifcData, idsData);

            // Remove the loading indicator
            loadingIndicator.remove();
            ifcSelect.disabled = false;
            idsSelect.disabled = false;

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
                loadingIndicator.innerHTML = `<div class="error">Validation failed: ${error.message}</div>`;
            }
            
            ifcSelect.disabled = false;
            idsSelect.disabled = false;
        }
    });
});

/**
 * Setup event handlers for expanding/collapsing requirement details
 */
function setupDetailHandlers() {
    document.addEventListener("click", function(event) {
        if (event.target.classList.contains("summary-toggle")) {
            var detailsElement = event.target.closest('details');
        
            if (detailsElement.hasAttribute('open')) {
                // If details are open, clear the content and close the details
                var reqIndex = event.target.dataset.reqIndex;
                var specIndex = event.target.dataset.specIndex;
                document.getElementById('table-container-' + specIndex + '-' + reqIndex).innerHTML = '';
                const loadMoreBtn = document.querySelector('.load-more[data-spec-index="' + specIndex + '"][data-req-index="' + reqIndex + '"]');
                if (loadMoreBtn) loadMoreBtn.style.display = 'none';
            } else {
                // If details are closed, load content
                var reqIndex = event.target.dataset.reqIndex;
                var specIndex = event.target.dataset.specIndex;
                var context = jsondata.specifications[specIndex].requirements[reqIndex];
                var templateScript = document.getElementById('json-template-IDS-requirement').innerHTML;
                var template = Handlebars.compile(templateScript);
        
                var initialRows = context.failed_entities.slice(0, 100);
                var html = template({failed_entities: initialRows});
                document.getElementById('table-container-' + specIndex + '-' + reqIndex).innerHTML = html;
        
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
            var context = jsondata.specifications[specIndex].requirements[reqIndex];
        
            // Determine the current count of loaded rows
            var currentCount = document.querySelectorAll('#table-container-' + specIndex + '-' + reqIndex + ' .row-class').length;
            console.log(currentCount);
            // Slice the next 100 rows based on the currentCount
            var additionalRows = context.failed_entities.slice(currentCount, currentCount + 100);
            var templateScript = document.getElementById('json-template-IDS-requirement').innerHTML;
            var template = Handlebars.compile(templateScript);
            var html = template({failed_entities: additionalRows});
        
            document.getElementById('table-container-' + specIndex + '-' + reqIndex).insertAdjacentHTML('beforeend', html);
        
            // Hide 'Load More' button if all rows are loaded
            if (currentCount + 100 >= context.failed_entities.length) {
                event.target.style.display = 'none';
            }
        }
    });
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

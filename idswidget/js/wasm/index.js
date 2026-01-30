/**
 * WASM module for IDS validation
 * Exposes an API that abstracts the underlying WASM thread using Pyodide
 */

// Message types for worker communication
export const MessageType = {
    // Initialize the WASM module
    INIT: 'init',

    // API call
    API_CALL: 'api_call',

    // Ready to serve API calls
    READY: 'ready',

    // API response
    API_RESPONSE: 'api_response',

    // Error
    ERROR: 'error',

    // Progress update
    PROGRESS: 'progress',

    // WASM module disposed
    DISPOSED: 'disposed'
};

class WASMModule {
    constructor() {
        this._messageId = 0;
        this.ready = false;
        this.worker = null;
        this.pendingMessages = new Map();
        this.onProgress = null; // Callback for progress updates
    }

    _generateId() {
        return `msg_${++this._messageId}_${Date.now()}`;
    }

    async init(onProgress = null) {
        if (this.ready === true) return;
        else if (this.ready instanceof Promise) return this.ready;

        this.onProgress = onProgress;

        // Use classic worker (not module) since we use importScripts for Pyodide
        this.worker = new Worker(new URL('./worker/worker.js', import.meta.url));

        this.worker.onmessage = (event) => {
            this._handleWorkerMessage(event.data);
        };

        this.worker.onerror = (error) => {
            console.error('[WASM] Web worker error:', error);
            this._rejectPendingMessages(error);
        };

        this.ready = new Promise(async (resolve, reject) => {
            try {
                await this._sendMessage(MessageType.INIT);
                this.ready = true;
                resolve(true);
            } catch (error) {
                console.error('[WASM] Failed to initialize:', error);
                this.ready = false;
                reject(error);
            }
        });

        return this.ready;
    }

    async _sendMessage(type, payload = {}) {
        if (!this.worker) throw new Error('Worker not initialized');

        const id = this._generateId();

        return new Promise((resolve, reject) => {
            this.pendingMessages.set(id, { resolve, reject });

            this.worker.postMessage({
                type,
                payload,
                id
            });
        });
    }

    _handleWorkerMessage({ type, payload, id }) {
        // Handle progress updates (no pending message)
        if (type === MessageType.PROGRESS) {
            if (this.onProgress) {
                this.onProgress(payload);
            }
            return;
        }

        const pendingMessage = this.pendingMessages.get(id);

        if (!pendingMessage) {
            console.warn('[WASM] Received response for unknown message ID:', id);
            return;
        }

        this.pendingMessages.delete(id);
        const { resolve, reject } = pendingMessage;

        switch (type) {
            case MessageType.READY:
                resolve();
                break;
            case MessageType.API_RESPONSE:
                resolve(payload);
                break;
            case MessageType.ERROR:
                reject(new Error(payload.message));
                break;
            default:
                console.warn('[WASM] Unknown message type:', type);
                reject(new Error(`Unknown message type: ${type}`));
        }
    }

    _rejectPendingMessages(error) {
        for (const { reject } of this.pendingMessages.values()) {
            reject(error);
        }
        this.pendingMessages.clear();
    }

    async _apiCall(method, ...args) {
        if (!this.ready) await this.init();

        const result = await this._sendMessage(MessageType.API_CALL, { method, args });
        return result;
    }

    /**
     * Load an IFC file. Returns a unique ID for the loaded file.
     * @param {ArrayBuffer} ifcData - The IFC file data as ArrayBuffer
     * @returns {Promise<string>} - Unique ID for the loaded IFC file
     */
    async loadIfc(ifcData) {
        return this._apiCall('loadIfc', ifcData);
    }

    /**
     * Unload an IFC file
     * @param {string} ifcId - The ID of the IFC file to unload
     */
    async unloadIfc(ifcId) {
        return this._apiCall('unloadIfc', ifcId);
    }

    /**
     * Pre-validate IDS against an IFC schema before running full validation.
     * This catches schema mismatches early and prevents Pyodide crashes.
     * @param {ArrayBuffer|Uint8Array} idsData - The IDS XML file data
     * @param {string} ifcSchema - The IFC schema name (e.g., "IFC2X3", "IFC4")
     * @returns {Promise<Object>} - Validation result with valid, error, entity_types, etc.
     */
    async preValidateIds(idsData, ifcSchema) {
        const idsBytes = idsData instanceof ArrayBuffer ? new Uint8Array(idsData) : idsData;
        return this._apiCall('preValidateIds', Array.from(idsBytes), ifcSchema);
    }

    /**
     * Audit a loaded IFC file against IDS specifications
     * @param {string} ifcId - The ID of the loaded IFC file
     * @param {ArrayBuffer|Uint8Array} idsData - The IDS XML file data
     * @returns {Promise<Object>} - Validation result with json and html reports
     */
    async auditIfc(ifcId, idsData) {
        const idsBytes = idsData instanceof ArrayBuffer ? new Uint8Array(idsData) : idsData;
        return this._apiCall('auditIfc', ifcId, Array.from(idsBytes));
    }

    /**
     * Cleanup resources
     */
    async dispose() {
        if (this.worker) {
            await this._apiCall('cleanup');
            this.worker.terminate();
            this.worker = null;
        }
        this.ready = false;
        this._rejectPendingMessages(new Error('WASM module disposed'));
    }
}

// Export singleton instance
const wasm = new WASMModule();

export const {
    init,
    loadIfc,
    unloadIfc,
    preValidateIds,
    auditIfc,
    dispose
} = {
    init: (onProgress) => wasm.init(onProgress),
    loadIfc: (ifcData) => wasm.loadIfc(ifcData),
    unloadIfc: (ifcId) => wasm.unloadIfc(ifcId),
    preValidateIds: (idsData, ifcSchema) => wasm.preValidateIds(idsData, ifcSchema),
    auditIfc: (ifcId, idsData) => wasm.auditIfc(ifcId, idsData),
    dispose: () => wasm.dispose()
};

export default wasm;

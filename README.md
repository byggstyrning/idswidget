# IDS Widget for StreamBIM

This project contains an IDS (Information Delivery Specification) widget for StreamBIM, built using FastHTML.

![chrome_8nXiRorPml](https://github.com/user-attachments/assets/0ad9700e-adfa-449c-b4ca-d46db8e756e7)

## Project Overview

The IDS Widget is a FastHTML application that provides functionality for validating IFC files against IDS specifications. It integrates with StreamBIM and uses **WASM-based validation** powered by Pyodide (Python in WebAssembly) to run ifcopenshell and ifctester directly in the browser.

## Architecture

The validation runs entirely in the browser using WebAssembly:

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│  ┌─────────────┐    ┌──────────────────────────────────────┐│
│  │ ids-widget  │───>│         Web Worker (WASM)            ││
│  │    .js      │    │  ┌────────────┐  ┌───────────────┐   ││
│  └─────────────┘    │  │  Pyodide   │  │ ifcopenshell  │   ││
│        │            │  │  (Python)  │  │  ifctester    │   ││
│        │            │  └────────────┘  └───────────────┘   ││
│        v            └──────────────────────────────────────┘│
│  ┌─────────────┐                                            │
│  │  StreamBIM  │                                            │
│  │    API      │                                            │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

### Key Benefits

- **No server-side processing**: Validation runs entirely in the browser
- **Simplified deployment**: Only a static file server is needed
- **Privacy**: IFC files never leave the user's browser
- **Scalability**: No server resources needed for validation

## Key Components

1. `idswidget/idswidget.py`: FastHTML application serving static files
2. `idswidget/js/wasm/`: WASM module for browser-based validation
   - `index.js`: Main API exposing `loadIfc()`, `auditIfc()` methods
   - `worker/worker.js`: Web Worker that loads Pyodide and runs Python
3. `idswidget/js/ids-widget.js`: Client-side JavaScript for widget functionality
4. `idswidget/config.json`: Configuration for WASM dependencies
5. `idswidget/json-templates/`: Handlebars templates for UI rendering

## Features

- IFC and IDS selection from uploaded StreamBIM documents and validation
- **Browser-based validation** using Pyodide (Python in WASM)
- JSON report generation with detailed validation results
- Integration with StreamBIM for 3D model visualization
- Highlighting of failed entities in the 3D model
- Copying element IDs for use in Revit
- Progress indicator during WASM initialization

## Integration with StreamBIM

This IDS Widget is designed to be integrated into your StreamBIM projects.

For more detailed information on how to use the StreamBIM Widget API, please refer to the [official documentation](https://github.com/streambim/streambim-widget-api).

### Running the Application

1. Clone this repository:
   ```
   git clone https://github.com/byggstyrning/idswidget.git
   cd idswidget
   ```

2. Build and run the Docker container:
   ```
   docker-compose up --build
   ```

3. Access the IDS widget at `http://localhost:4000`.

4. Host the widget on a publicly accessible URL, either self-hosted or on a public cloud service.

5. Contact StreamBIM support (support@rendra.io) to whitelist the widget in your project and let them know the widget URL and what you want to call the widget.

6. Once approved, you'll see the widget in the StreamBIM interface, allowing users to select IFC files and perform IDS validations directly within the StreamBIM environment.

## Project Structure

- `idswidget/`: Contains the main FastHTML application and WASM modules
  - `js/wasm/`: WASM validation module
  - `json-templates/`: Handlebars templates for report rendering
- `ifctester/`: (Legacy) Server-side validation service - no longer needed with WASM

## WASM Dependencies

The validation uses the following components loaded via Pyodide:

- **Pyodide**: Python runtime compiled to WebAssembly
- **ifcopenshell**: IFC file parsing and manipulation
- **ifctester**: IDS specification validation

These are loaded from CDN/PyPI on first use. Initial load may take 10-30 seconds depending on connection speed.

## Configuration

The `config.json` file contains URLs for WASM dependencies:

```json
{
    "wasm": {
        "pyodide_url": "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/",
        "wheel_url": "...",
        "odfpy_url": "..."
    }
}
```

## Contributing

We welcome contributions to the IDS Widget project! Feel free to fork the repository, make your changes, and open a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

## IFC Validation

The IFC validation functionality uses [ifcopenshell](https://github.com/IfcOpenShell/IfcOpenShell) and [ifctester](https://github.com/IfcOpenShell/IfcOpenShell/tree/v0.8.0/src/ifctester) running in the browser via Pyodide WebAssembly.

The WASM implementation is based on the [ifctester webapp](https://github.com/IfcOpenShell/IfcOpenShell/tree/v0.8.0/src/ifctester/webapp).

## StreamBIM Widget API Integration

The StreamBIM Widget API (`streambim-widget-api.min.js`) is automatically downloaded during the Docker build process and placed in the `/js/` directory. This ensures that the widget has access to the necessary StreamBIM integration functions without manual intervention.

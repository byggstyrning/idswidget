"""
IDS Widget FastHTML Application

This module implements an IDS (Information Delivery Specification) widget
for StreamBIM using FastHTML. It serves the static files for the WASM-based
IFC/IDS validation that runs entirely in the browser.
"""

from fasthtml.common import *
import os
import time
import logging

logger = logging.getLogger(__name__)

# Define default headers for the HTML output
hdrs = (  
    Link(rel="stylesheet", href=f"/styles.css?t={int(time.time())}"),
    Link(rel="stylesheet", href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css"),
    Script(src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/4.7.7/handlebars.min.js"),
    Script(src="/js/streambim-widget-api.min.js"),
    # Load main widget script as ES module for WASM support
    Script(src=f"/js/ids-widget.js?t={int(time.time())}", type="module"),
    Meta(charset="utf-8"),
)

def _continue():
    """Placeholder function for Beforeware."""
    pass

# Create the Beforeware instance with the before function
bware = Beforeware(_continue, skip=[r'/favicon\.ico', r'/js/.*', r'.*\.css', r'/config\.json'])

app, rt = fast_app(
    before=bware,
    hdrs=hdrs,
    pico=False,
)

def load_template(filename: str) -> str:
    """
    Load a template file and return its contents.

    Args:
        filename (str): The path to the template file.

    Returns:
        str: The contents of the template file, or an empty string if an error occurs.
    """
    try:
        with open(filename, 'r') as file:
            return file.read()
    except FileNotFoundError:
        logger.error(f"Template file '{filename}' not found.")
        return ""
    except IOError as e:
        logger.error(f"Error reading template file '{filename}': {str(e)}")
        return ""

@rt('/')
def get():
    """
    Handle GET requests to the root URL.

    Returns:
        tuple: A tuple containing FastHTML elements for the main page.
    """
    return (
        Div(
            Select(Option("Loading IDS files..."), name="ids_filename", cls="file-dropdown", disabled=True),
            Select(Option("Loading IFC files..."), name="ifc_filename", cls="file-dropdown", disabled=True),
            Button("Validate", id="validate", cls="validate-btn"),
            cls="file-selection-container",
        ),
        Div(id="report"),
        Script(
            load_template("/app/json-templates/json-template-IDS.html"),
            type="text/x-handlebars-template",
            id="json-template-IDS",
        ),
        Script(
            load_template("/app/json-templates/json-template-IDS-requirement.html"),
            type="text/x-handlebars-template",
            id="json-template-IDS-requirement",
        ),
    )

@rt('/config.json')
def get_config():
    """
    Serve the WASM configuration file.
    """
    try:
        with open('/app/config.json', 'r') as f:
            import json
            config = json.load(f)
            return config
    except Exception as e:
        logger.error(f"Error loading config.json: {str(e)}")
        return {"error": str(e)}, 500

@rt('/health')
def health_check():
    """
    Health check endpoint.
    """
    return {"status": "healthy", "mode": "wasm"}

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    serve(port=port)

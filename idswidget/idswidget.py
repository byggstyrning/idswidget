"""
IDS Widget FastHTML Application

This module implements an IDS (Information Delivery Specification) widget
for StreamBIM using FastHTML. It serves the static files for the WASM-based
IFC/IDS validation that runs entirely in the browser.
"""

from fasthtml.common import *
from starlette.requests import Request
from starlette.responses import Response
import os
import time
import logging
import requests
import json

logger = logging.getLogger(__name__)

# Cache-busting timestamp - generated once at module load
CACHE_BUST = int(time.time())

# Define default headers for the HTML output
hdrs = (  
    Link(rel="stylesheet", href=f"/styles.css?t={CACHE_BUST}"),
    Link(rel="stylesheet", href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css"),
    Script(src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/4.7.7/handlebars.min.js"),
    Script(src=f"/js/streambim-widget-api.min.js?t={CACHE_BUST}"),
    # Connect to StreamBIM IMMEDIATELY with inline sync script (before ES module loads)
    # Using the OLD v2 API: connect() instead of connectToParent()
    # This matches the Penpal version used by StreamBIM's production app
    Script("""
        // v2 API: connect(methods) - no window parameter
        try {
            window._streamBIMConnection = StreamBIM.connect({
                // Callback when widget expansion state changes
                expandedChanged: function(isExpanded) {
                    console.log('[IDS Widget] Expanded state changed:', isExpanded);
                    if (isExpanded) {
                        document.body.style.backgroundColor = '#343434';
                    } else {
                        // Reset to default (transparent/inherited from StreamBIM)
                        document.body.style.backgroundColor = '';
                    }
                }
            });
            window._streamBIMConnection.catch(function(e) {
                console.error('StreamBIM connection failed:', e);
            });
        } catch(err) {
            console.error('StreamBIM connect() error:', err);
        }
    """),
    # Load main widget script as ES module for WASM support
    Script(src=f"/js/ids-widget.js?t={CACHE_BUST}", type="module"),
    Meta(charset="utf-8"),
)

def _continue():
    """Placeholder function for Beforeware."""
    pass

# Create the Beforeware instance with the before function
bware = Beforeware(_continue, skip=[r'/favicon\.ico', r'/js/.*', r'.*\.css', r'/config\.json', r'/proxy/.*', r'/wheels/.*'])

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
        # Try multiple paths in case of different deployment scenarios
        config_paths = ['/app/config.json', './config.json', 'config.json']
        config = None
        
        for path in config_paths:
            try:
                with open(path, 'r') as f:
                    config = json.load(f)
                    break
            except FileNotFoundError:
                continue
        
        if config is None:
            raise FileNotFoundError("config.json not found in any expected location")
        
        # FastHTML should handle JSON automatically, but add CORS headers
        return Response(
            content=json.dumps(config),
            media_type='application/json',
            headers={'Access-Control-Allow-Origin': '*'}
        )
    except Exception as e:
        logger.error(f"Error loading config.json: {str(e)}")
        return Response(
            content=json.dumps({"error": str(e)}),
            status_code=500,
            media_type='application/json',
            headers={'Access-Control-Allow-Origin': '*'}
        )

@rt('/proxy/download')
def proxy_download(url: str, request: Request = None):
    """
    Proxy endpoint to download files from StreamBIM, avoiding CORS issues.
    Forwards cookies from the client request to StreamBIM.
    """
    try:
        # Get cookies and headers from the incoming request
        cookies = ''
        user_agent = 'IDS-Widget/1.0'
        
        if request:
            cookies = request.headers.get('Cookie', '')
            user_agent = request.headers.get('User-Agent', user_agent)
        
        # Make request to StreamBIM with forwarded cookies
        headers = {
            'User-Agent': user_agent
        }
        if cookies:
            headers['Cookie'] = cookies
        
        response = requests.get(
            url,
            headers=headers,
            stream=True,
            timeout=300
        )
        
        response.raise_for_status()
        
        # Return the file content with appropriate headers
        return Response(
            content=response.content,
            headers={
                'Content-Type': response.headers.get('Content-Type', 'application/octet-stream'),
                'Content-Length': str(len(response.content)),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true'
            }
        )
    except requests.RequestException as e:
        logger.error(f"Proxy download error: {str(e)}")
        return {"error": f"Failed to download file: {str(e)}"}, 500

@rt('/proxy/wheel')
def proxy_wheel(url: str):
    """
    Proxy endpoint to download Python wheel files, avoiding CORS issues.
    Used for downloading ifcopenshell and other wheels for Pyodide.
    """
    try:
        logger.info(f"Proxy wheel request for: {url}")
        
        # Use a browser-like User-Agent to avoid being blocked
        response = requests.get(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/octet-stream,*/*'
            },
            allow_redirects=True,
            timeout=600  # Longer timeout for large wheel files
        )
        
        logger.info(f"Proxy wheel response: status={response.status_code}, size={len(response.content)}, content-type={response.headers.get('Content-Type', 'unknown')}")
        
        response.raise_for_status()
        
        # Verify we got a zip-like file (wheel files start with PK)
        content = response.content
        if len(content) < 4 or content[:2] != b'PK':
            logger.error(f"Proxy wheel: Response does not appear to be a zip file. First 100 bytes: {content[:100]}")
            return Response(
                content=json.dumps({"error": "Downloaded content is not a valid wheel file"}),
                status_code=502,
                media_type='application/json',
                headers={'Access-Control-Allow-Origin': '*'}
            )
        
        # Return the wheel file with appropriate headers
        return Response(
            content=content,
            headers={
                'Content-Type': 'application/zip',  # Wheel files are zip archives
                'Content-Length': str(len(content)),
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
                'Cache-Control': 'public, max-age=86400'  # Cache for 24 hours
            }
        )
    except requests.RequestException as e:
        logger.error(f"Proxy wheel download error: {str(e)}")
        return Response(
            content=json.dumps({"error": f"Failed to download wheel: {str(e)}"}),
            status_code=500,
            media_type='application/json',
            headers={'Access-Control-Allow-Origin': '*'}
        )

@rt('/wheels/{filename}')
def serve_wheel(filename: str):
    """
    Serve pre-downloaded wheel files for Pyodide.
    These are downloaded during Docker build for reliability.
    """
    # Try multiple paths
    wheel_paths = [f'/app/wheels/{filename}', f'./wheels/{filename}', f'wheels/{filename}']
    
    for wheel_path in wheel_paths:
        if os.path.exists(wheel_path):
            try:
                with open(wheel_path, 'rb') as f:
                    content = f.read()
                
                logger.info(f"Serving wheel: {filename} ({len(content)} bytes)")
                
                return Response(
                    content=content,
                    headers={
                        'Content-Type': 'application/zip',
                        'Content-Length': str(len(content)),
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'public, max-age=86400'
                    }
                )
            except IOError as e:
                logger.error(f"Error reading wheel file {wheel_path}: {str(e)}")
    
    logger.error(f"Wheel file not found: {filename}")
    return Response(
        content=json.dumps({"error": f"Wheel file not found: {filename}"}),
        status_code=404,
        media_type='application/json',
        headers={'Access-Control-Allow-Origin': '*'}
    )

@rt('/health')
def health_check():
    """
    Health check endpoint.
    """
    return {"status": "healthy", "mode": "wasm"}

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    serve(port=port)

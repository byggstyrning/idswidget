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
import socket
import ipaddress
from urllib.parse import urlsplit, urljoin

logger = logging.getLogger(__name__)

# The download proxy only fetches from StreamBIM (any *.streambim.com host)
PROXY_ALLOWED_DOMAIN = 'streambim.com'
PROXY_MAX_REDIRECTS = 5

# Cache-busting timestamp - generated once at module load
CACHE_BUST = int(time.time())

# Define default headers for the HTML output
hdrs = (  
    Link(rel="stylesheet", href=f"/styles.css?t={CACHE_BUST}"),
    Link(rel="stylesheet", href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css"),
    Script(src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/4.7.10/handlebars.min.js"),
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
bware = Beforeware(_continue, skip=[r'/favicon\.ico', r'/js/.*', r'.*\.css', r'/config\.json', r'/proxy/download', r'/wheels/.*'])

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
    # Try multiple paths for different deployment scenarios
    paths_to_try = [
        filename,  # Original path (Docker: /app/json-templates/...)
        filename.replace('/app/', './'),  # Local: ./json-templates/...
        filename.replace('/app/', ''),  # Relative: json-templates/...
    ]
    
    for path in paths_to_try:
        try:
            with open(path, 'r') as file:
                return file.read()
        except FileNotFoundError:
            continue
        except IOError as e:
            logger.error(f"Error reading template file '{path}': {str(e)}")
            continue
    
    logger.error(f"Template file '{filename}' not found in any expected location.")
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

def _is_public_host(hostname: str) -> bool:
    """Return True if every address the hostname resolves to is a public IP."""
    try:
        infos = socket.getaddrinfo(hostname, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    return all(ipaddress.ip_address(info[4][0]).is_global for info in infos)

def _is_allowed_proxy_url(url: str, first_hop: bool) -> bool:
    """
    The first request must go to StreamBIM over https. Redirects (e.g. to file
    storage) may leave StreamBIM, but only over https to public addresses.
    """
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    if parts.scheme != 'https' or not host or parts.username or parts.password:
        return False
    is_streambim = host == PROXY_ALLOWED_DOMAIN or host.endswith('.' + PROXY_ALLOWED_DOMAIN)
    if first_hop and not is_streambim:
        return False
    return _is_public_host(host)

def _proxy_error(message: str, status_code: int) -> Response:
    return Response(
        content=json.dumps({"error": message}),
        status_code=status_code,
        media_type='application/json'
    )

@rt('/proxy/download')
def proxy_download(url: str, request: Request = None):
    """
    Proxy endpoint to download files from StreamBIM, avoiding CORS issues.
    Only StreamBIM URLs are accepted; redirects are followed manually so each
    hop is checked. Client cookies are not forwarded.
    """
    user_agent = 'IDS-Widget/1.0'
    if request:
        user_agent = request.headers.get('User-Agent', user_agent)

    if not _is_allowed_proxy_url(url, first_hop=True):
        logger.warning(f"Proxy download rejected URL host: {urlsplit(url).hostname}")
        return _proxy_error("URL not allowed", 400)

    try:
        current_url = url
        for _ in range(PROXY_MAX_REDIRECTS + 1):
            response = requests.get(
                current_url,
                headers={'User-Agent': user_agent},
                allow_redirects=False,
                timeout=300
            )
            if not response.is_redirect:
                break
            next_url = urljoin(current_url, response.headers['Location'])
            if not _is_allowed_proxy_url(next_url, first_hop=False):
                logger.warning(f"Proxy download rejected redirect to: {urlsplit(next_url).hostname}")
                return _proxy_error("Redirect target not allowed", 502)
            current_url = next_url
        else:
            return _proxy_error("Too many redirects", 502)

        response.raise_for_status()

        # Same-origin use only: no CORS headers, so other sites can't read the result
        return Response(
            content=response.content,
            headers={
                'Content-Type': response.headers.get('Content-Type', 'application/octet-stream'),
                'Content-Length': str(len(response.content))
            }
        )
    except requests.RequestException as e:
        logger.error(f"Proxy download error: {type(e).__name__}")
        return _proxy_error("Failed to download file", 502)

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

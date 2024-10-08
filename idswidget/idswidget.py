"""
IDS Widget FastHTML Application

This module implements an IDS (Information Delivery Specification) widget
for StreamBIM using FastHTML. It provides functionality for validating
IFC files against IDS specifications.
"""

from fasthtml.common import *
from pydantic import BaseModel
import os
import requests
import json
from typing import Dict, Any
from shared.classes import IfcTesterRequest
import time
import logging

logger = logging.getLogger(__name__)

# Define default headers for the HTML output
hdrs = (  
    Link(rel="stylesheet", href=f"/styles.css?t={int(time.time())}"),
    Link(rel="stylesheet", href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.1.1/css/all.min.css"),
    Script(src="https://cdnjs.cloudflare.com/ajax/libs/handlebars.js/4.7.7/handlebars.min.js"),

    Script(src="/js/streambim-widget-api.min.js"),
    Script(src=f"/js/ids-widget.js?t={int(time.time())}"),
    Meta(charset="utf-8"),
)

def _continue():
    """Placeholder function for Beforeware."""
    pass

# Create the Beforeware instance with the before function
bware = Beforeware(_continue, skip=[r'/favicon\.ico', r'/js/.*', r'.*\.css'])

app, rt = fast_app(
    before=bware,
    hdrs=hdrs,
    pico=False,
)

IFCPIPELINEURL = "http://ifctester/ifctester"

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

@rt('/validate')   
def post(projectID: str, downloadlinkIfc: str, downloadlinkIds: str, filename: str, uploadDate: str, fileSize: str, idsFilename: str):
    """
    Handle POST requests to validate IFC files.

    Args:
        projectID (str): The ID of the project.
        downloadlinkIfc (str): The URL to download the IFC file.    
        downloadlinkIds (str): The URL to download the IDS file.
        filename (str): The name of the IFC file.
        idsFilename (str): The name of the IDS file.
        uploadDate (str): The upload date of the file.
        fileSize (str): The size of the file.

    Returns:
        dict: The validation result as a JSON object.
    """
    # Create a unique identifier for the file
    file_identifier = f"{filename}_{idsFilename}_{uploadDate}_{fileSize}"
    safe_identifier = ''.join(c if c.isalnum() else '_' for c in file_identifier)
    
    # Ensure the project-specific 'uploads' directory exists
    project_dir = os.path.join('uploads', projectID)
    if not os.path.exists(project_dir):
        os.makedirs(project_dir)
        os.chmod(project_dir, 0o755)  # rwxr-xr-x

    # Check if the file with this identifier already exists
    existing_files = [f for f in os.listdir(project_dir) if f.startswith(safe_identifier)]
    if existing_files:
        existing_file = existing_files[0]
        output_filename = existing_file.replace('.ifc', '.json')
        output_path = os.path.join(project_dir, output_filename)
        if os.path.exists(output_path):
            with open(output_path, 'r') as f:
                return json.load(f)

    # If not found, download the file
    responseIfc = requests.get(downloadlinkIfc)
    responseIds = requests.get(downloadlinkIds)
    if responseIfc.status_code != 200:
        return json.dumps({"error": "Failed to download the IFC file"}), 400
    if responseIds.status_code != 200:
        return json.dumps({"error": "Failed to download the IDS file"}), 400


    # Save the file with the unique identifier
    file_path_ifc = os.path.join(project_dir, f"{safe_identifier}.ifc")
    file_path_ids = os.path.join(project_dir, f"{idsFilename}")
    with open(file_path_ifc, 'wb') as f:
        f.write(responseIfc.content)
    with open(file_path_ids, 'wb') as f:
        f.write(responseIds.content)

    # Prepare for validation
    output_filename = f"{safe_identifier}.json"
    output_path = os.path.join(project_dir, output_filename)
    
    validation_payload = IfcTesterRequest(
        ifc_filename=file_path_ifc,
        ids_filename=file_path_ids,
        output_filename=output_path,
        report_type="json",
        projectID=projectID
    )

    # Perform validation
    try:
        validation_response = requests.post(
            IFCPIPELINEURL,
            json=validation_payload.model_dump()
        )
        validation_response.raise_for_status()
        
        result = validation_response.json()
        
        # Delete the IFC and IDS files after validation
        os.remove(file_path_ifc)
        os.remove(file_path_ids)

        # Save validation result
        with open(output_path, 'w') as f:
            json.dump(result, f)
        
        return result
    except requests.RequestException as e:
        error_msg = f"Validation failed: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg}, 400

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    serve(port=port)
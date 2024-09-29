from pydantic import BaseModel

class IfcTesterRequest(BaseModel):
    ifc_filename: str
    ids_filename: str
    output_filename: str
    report_type: str = "json"
    projectID: str
from fastapi import FastAPI, HTTPException, Depends, Response
from shared.classes import IfcTesterRequest
import ifcopenshell
from ifctester import ids, reporter
import os
import json

app = FastAPI()


@app.post("/ifctester", summary="Validate IFC against IDS", tags=["Validation"])
async def ifctester(request: IfcTesterRequest, response: Response):
    try:
        project_upload_dir = f"/app/uploads/{request.projectID}"
        os.makedirs(project_upload_dir, exist_ok=True)
        
        # Process IFC filename
        ifc_filename = request.ifc_filename.replace(f"uploads/{request.projectID}/", "")
        ifc_path = os.path.join(project_upload_dir, ifc_filename)
        
        # Process IDS filename
        ids_filename = request.ids_filename.replace(f"uploads/{request.projectID}/", "")
        ids_path = os.path.join(project_upload_dir, ids_filename)
        
        # Process output filename
        output_filename = request.output_filename.replace(f"uploads/{request.projectID}/", "")
                
        report_type = request.report_type

        if not os.path.exists(ifc_path):
            raise HTTPException(status_code=404, detail=f"IFC file {ifc_filename} not found in {project_upload_dir}")
        if not os.path.exists(ids_path):
            raise HTTPException(status_code=404, detail=f"IDS file {ids_filename} not found in {project_upload_dir}")

        # Load the IDS file
        my_ids = ids.open(ids_path)

        # Open the IFC file
        my_ifc = ifcopenshell.open(ifc_path)

        # Validate IFC model against IDS requirements
        my_ids.validate(my_ifc)

        if report_type == "json":
            # Generate JSON report
            json_reporter = reporter.Json(my_ids)
            json_reporter.report()
            json_reporter.to_file(output_filename)

            # Get a summary of the results
            total_specs = len(my_ids.specifications)
            passed_specs = sum(1 for spec in my_ids.specifications if spec.status)
            failed_specs = total_specs - passed_specs

            return {
                "success": True,
                "total_specifications": total_specs,
                "passed_specifications": passed_specs,
                "failed_specifications": failed_specs,
                "report": json_reporter.to_string()
            }
        
        if report_type == "html":
            # Generate JSON report
            html_reporter = reporter.Html(my_ids)
            html_reporter.report()
            html_reporter.to_file(output_filename)


            return {
                "success": True,
                "report": html_reporter.to_string()
            }
    except Exception as e:
        # Log the full error for debugging
        print(f"Error in ifctester: {str(e)}")
        
        # Return a JSON error response
        response.headers["Content-Type"] = "application/json"
        response.status_code = 500
        return json.dumps({"success": False, "error": str(e)})

@app.get("/health")
async def health_check():
    return {"status": "healthy"}
FROM python:3.10-slim

WORKDIR /app

# Install curl for downloading files
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY idswidget/ .
RUN pip install -r requirements.txt

# Use the local streambim-widget-api.min.js that's already in the repo
# DO NOT download from GitHub - the master branch has a newer Penpal version
# that's incompatible with StreamBIM's production app

# Download Python wheels for WASM at build time (more reliable than runtime)
# Using IfcOpenShell/wasm-wheels repo - the official source for Pyodide-compatible wheels
# odfpy wheel is from IfcOpenShell's ifctester webapp (custom-built wheel with py2.py3-none-any tag)
RUN mkdir -p /app/wheels && \
    curl -L -o /app/wheels/ifcopenshell-0.8.2-cp312-cp312-emscripten_3_1_58_wasm32.whl \
        "https://raw.githubusercontent.com/IfcOpenShell/wasm-wheels/main/ifcopenshell-0.8.2%2Bd50e806-cp312-cp312-emscripten_3_1_58_wasm32.whl" && \
    curl -L -o /app/wheels/odfpy-1.4.2-py2.py3-none-any.whl \
        "https://raw.githubusercontent.com/IfcOpenShell/IfcOpenShell/v0.8.0/src/ifctester/webapp/public/worker/bin/odfpy-1.4.2-py2.py3-none-any.whl" && \
    ls -la /app/wheels/

CMD ["python", "idswidget.py"]

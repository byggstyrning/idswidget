FROM python:3.13-slim

WORKDIR /app

# constraints.txt locks transitive deps so rebuilds are reproducible
# (regenerate it with `pip freeze` after deliberately upgrading requirements.txt)
COPY idswidget/requirements.txt idswidget/constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt

COPY idswidget/ .

# Use the local streambim-widget-api.min.js that's already in the repo
# DO NOT download from GitHub - the master branch has a newer Penpal version
# that's incompatible with StreamBIM's production app

# Pyodide wheels are committed in wheels/ (ifcopenshell from IfcOpenShell/wasm-wheels,
# odfpy from IfcOpenShell's ifctester webapp). Fail the build if they've been altered.
RUN printf '%s\n' \
    'f7dfe36e166365dc9dabd0913d2020f84ba536045762f48a5450fe21cc0bc2b7  wheels/ifcopenshell-0.8.2-cp312-cp312-emscripten_3_1_58_wasm32.whl' \
    '29dcd08f85303642875b033c70b11942eec74c299c1c7f3cba340347eeba9283  wheels/odfpy-1.4.2-py2.py3-none-any.whl' \
    | sha256sum -c -

# Run as an unprivileged user (FastHTML writes .sesskey into /app on first start)
RUN useradd --system --no-create-home app && chown -R app /app
USER app

CMD ["python", "idswidget.py"]

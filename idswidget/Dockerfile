FROM python:3.10-slim

WORKDIR /app

# Install curl for downloading files
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY shared /app/shared
RUN pip install -e /app/shared

COPY idswidget/ .
RUN pip install -r requirements.txt

# Download streambim-widget-api.min.js
ADD https://github.com/streambim/streambim-widget-api/raw/master/dist/streambim-widget-api.min.js /app/js/streambim-widget-api.min.js

CMD ["python", "idswidget.py"]
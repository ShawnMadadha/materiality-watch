# Apify-provided Python base image with the Apify SDK preinstalled
FROM apify/actor-python:3.13

# Copy and install dependencies first to maximize Docker layer caching
COPY requirements.txt ./
RUN echo "Python: $(python --version)" \
 && pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt \
 && pip freeze

# Copy the actor source
COPY . ./

# Run as a Python module — uses src/__main__.py
CMD ["python", "-m", "src"]

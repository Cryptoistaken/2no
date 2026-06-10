FROM python:3.12-slim

RUN apt-get update && apt-get install -y nodejs npm ca-certificates && rm -rf /var/lib/apt/lists/* && \
    pip install tls_client typing_extensions --break-system-packages --no-cache-dir && \
    ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./

CMD ["node", "index.js"]
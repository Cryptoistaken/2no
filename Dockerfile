FROM mcr.microsoft.com/playwright:v1.60.0-noble

RUN apt-get update && apt-get install -y curl xvfb unzip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./

ENV DOCKER=1

CMD ["sh", "-c", "xvfb-run -a -s \"-screen 0 1920x1080x24\" node index.js"]

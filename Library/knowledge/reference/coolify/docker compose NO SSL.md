version: '3.8'

services:
  # Nginx - Serves static sub-apps
  nginx:
    image: nginx:alpine
    restart: always
    ports:
      - "8090:80"
    volumes:
      - /opt/boutabyte/hostinger/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - webapp_data:/usr/share/nginx/html
    command: [nginx, '-g', 'daemon off;']
    networks:
      - boutabyte

  # n8n - Automation engine
  n8n:
    image: n8nio/n8n:latest
    restart: always
    ports:
      - "5679:5678"
    environment:
      - N8N_HOST=${N8N_HOST:-n8n.boutabyte.com}
      - N8N_PROTOCOL=https
      - WEBHOOK_URL=${WEBHOOK_URL:-https://n8n.boutabyte.com/}
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=${N8N_USER}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_PASS}
      - N8N_SECURE_COOKIE=false
      - GENERIC_TIMEZONE=America/Chicago
    volumes:
      - n8n_data:/home/node/.n8n
      - webapp_data:/data/webapps:ro
    networks:
      - boutabyte

  # File API - Handles uploads from Netlify
  file-api:
    build: /opt/boutabyte/hostinger/file-api
    restart: always
    ports:
      - "3002:3001"
    environment:
      - API_KEY=${FILE_API_KEY}
      - WEBAPPS_DIR=/data/webapps
      - PORT=3001
    volumes:
      - webapp_data:/data/webapps
    networks:
      - boutabyte

networks:
  boutabyte:
    driver: bridge

volumes:
  webapp_data:
  n8n_data:
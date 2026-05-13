FROM node:18-alpine
WORKDIR /app

# Install cloudflared
RUN apk add --no-cache curl && \
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Install deps
COPY package.json ./
RUN npm install

COPY . .
RUN mkdir -p auth_sessions

# Start server + cloudflared tunnel
CMD cloudflared tunnel --no-autoupdate run --token eyJhIjoiYmU5ZmIwMGMzNDhlMTBkNjBlNDMxMjk4ZTYyYTM2MjEiLCJ0IjoiNmNiYTgxYzYtNzZhZi00MWE4LWJmOGItZDJkZDc5ZjNkYWVmIiwicyI6Ik9ETmxZakpsWkRRdFpEQmlOeTAwTm1Vd0xXSTVPRGt0WmpJMVptUTJNRGszTVdOaSJ9 & node server.js

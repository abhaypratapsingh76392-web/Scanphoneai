FROM node:20-alpine
RUN apk add --no-cache python3
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]

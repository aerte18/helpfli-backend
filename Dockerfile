# Dev-friendly Node image
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci && npm i -g nodemon
COPY . .
EXPOSE 5000
CMD ["npm", "run", "dev"]
























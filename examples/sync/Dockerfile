FROM node:22-alpine
WORKDIR /app
COPY demo-api.mjs ./
RUN npm install pg@8.16.3
ENV TOKEN_PORT=8081
EXPOSE 8081
CMD ["node", "demo-api.mjs"]

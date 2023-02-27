# syntax=docker/dockerfile:1
   
FROM node:18-alpine
WORKDIR ./
COPY . .
RUN npm i
CMD ["npm", "start"]
ENV NODE_ENV=prod
EXPOSE 3000
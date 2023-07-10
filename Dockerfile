FROM node:18-alpine

RUN apk add --upgrade tini

COPY dist/server /server

CMD ["tini", "--", "NODE_ENV=production", "node", "/server/index.mjs"]

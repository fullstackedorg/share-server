FROM node:18-alpine

RUN apk add --upgrade tini

COPY dist/server /server

CMD ["tini", "--", "node", "/server/index.mjs"]

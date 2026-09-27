FROM node:20-alpine

# rsync/openssh-client/sshpass are for the Settings tab's (hidden, opt-in)
# "Import Blockchain" feature - see lib/blockchainImport.js. Not needed for
# anything else the app does.
RUN apk add --no-cache rsync openssh-client sshpass

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

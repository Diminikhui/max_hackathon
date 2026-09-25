# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /workspace

RUN corepack enable

COPY . .

RUN --mount=type=cache,id=max-hackathon-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV MAX_CA_CERT_PATH=/workspace/certs/russian_trusted_root_ca.crt

WORKDIR /workspace

COPY --from=build --chown=node:node /workspace /workspace

USER node

# The public Russian Trusted CA is copied with certs/. It is added only to the
# trust store of the launched Node.js process and only when K-05a has supplied it.
ENTRYPOINT ["/bin/sh", "-c", "if [ -f \"$MAX_CA_CERT_PATH\" ]; then export NODE_EXTRA_CA_CERTS=\"$MAX_CA_CERT_PATH\"; fi; exec \"$@\"", "max-hackathon"]

FROM runtime AS bot

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "process.kill(1, 0)"]

CMD ["node", "apps/bot/dist/main.js"]

FROM runtime AS worker

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "process.kill(1, 0)"]

CMD ["node", "apps/worker/dist/main.js"]

FROM runtime AS miniapp-api

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "process.kill(1, 0)"]

CMD ["node", "apps/miniapp-api/dist/main.js"]

FROM runtime AS miniapp

ENV MINIAPP_PORT=4173

EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--input-type=module", "-e", "import{createReadStream,statSync}from'node:fs';import{createServer}from'node:http';import{extname,join}from'node:path';const root='/workspace/apps/miniapp/dist';const types={'.css':'text/css','.html':'text/html','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml'};createServer((req,res)=>{const path=decodeURIComponent(new URL(req.url??'/','http://localhost').pathname);const rel=path.split('/').filter(part=>part&&part!=='.'&&part!=='..').join('/');let file=join(root,rel||'index.html');try{if(statSync(file).isDirectory())file=join(file,'index.html');}catch{file=join(root,'index.html');}res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');createReadStream(file).on('error',()=>{res.statusCode=404;res.end('Not found');}).pipe(res);}).listen(Number(process.env.MINIAPP_PORT??4173),'0.0.0.0');"]

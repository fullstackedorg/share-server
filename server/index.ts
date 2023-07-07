import Server from "@fullstacked/webapp/server";
import {WebSocketServer, WebSocket} from "ws";
import randStr from "@fullstacked/cli/utils/randStr";
import type {IncomingMessage, ServerResponse} from "http";

const server = new Server();

const wss = new WebSocketServer({noServer: true});

const proxyWSS = new WebSocketServer({noServer: true});
const proxiedWS = new Map<string, WebSocket>()
server.serverHTTP.on("upgrade", (request, socket, head) => {
    const host = request.headers.host;
    const firstDomainPart = host.split(".").shift();

    const proxyWS = activeWS.get(firstDomainPart);
    if(proxyWS){
        proxyWSS.handleUpgrade(request, socket, head, (ws) => {
            console.log(request.url);
            const wsId = randStr();
            proxiedWS.set(wsId, ws);
            proxyWS.send(JSON.stringify({
                ws: true,
                wsId,
                headers: request.headers,
                url: request.url
            }));
            proxyWSS.emit('connection', ws, request);
        });
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

const wsReqs = new Map<string, (data: any) => void>()
function awaitReq(ws: WebSocket, data: object){
    const reqId = randStr();
    ws.send(JSON.stringify({
        ...data,
        reqId
    }))
    return new Promise<any>(resolve => {
        wsReqs.set(reqId, resolve)
    });
}

const activeWS = new Map<string, WebSocket>()
wss.on("connection", (ws) => {
    const hash = randStr();
    activeWS.set(hash, ws);
    ws.send(JSON.stringify({hash}))
    ws.on("message", (message) => {
        const rawData = JSON.parse(message.toString());

        if(rawData.ws){
            const proxyWS = proxiedWS.get(rawData.wsId);
            proxyWS.send(rawData.data.toString());
            return;
        }

        const {reqId, data} = rawData;
        const awaitingReq = wsReqs.get(reqId);
        awaitingReq(data);
    });
})

server.start();

server.addListener({
    prefix: "default",
    async handler(req: IncomingMessage, res: ServerResponse): Promise<any> {
        const host = req.headers.host;
        const firstDomainPart = host.split(".").shift();
        const ws = activeWS.get(firstDomainPart);
        if(!ws) return;

        const {headers, method, url} = req;
        const data = await awaitReq(ws, {headers, method, url});
        data.headers.forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.writeHead(data.status);
        res.end(data.body);
    }
}, true);

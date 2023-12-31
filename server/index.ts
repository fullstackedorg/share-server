import Server from "@fullstacked/webapp/server";
import {WebSocketServer, WebSocket} from "ws";
import randStr from "@fullstacked/cli/utils/randStr";
import type {IncomingMessage, ServerResponse} from "http";

const server = new Server();

server.addListener({
    prefix: "default",
    handler(req: IncomingMessage, res: ServerResponse): any {
        if(req.url !== "/hello") return;
        res.end("Bonjour");
    }
}, true);

const wss = new WebSocketServer({noServer: true});

const proxyWSS = new WebSocketServer({noServer: true});
const proxiedWS = new Map<string, WebSocket>()
server.serverHTTP.on("upgrade", (request, socket, head) => {
    const host = request.headers.host;
    const firstDomainPart = host.split(".").shift();

    const proxyWS = activeWS.get(firstDomainPart);
    if(proxyWS){
        proxyWSS.handleUpgrade(request, socket, head, (ws) => {
            const wsId = randStr();
            proxiedWS.set(wsId, ws);
            proxyWS.send(JSON.stringify({
                ws: true,
                wsId,
                headers: request.headers,
                url: request.url
            }));
            ws.on("close", () => {
                proxyWS.send(JSON.stringify({
                    ws: true,
                    wsId,
                    close: true
                }));
                proxiedWS.delete(wsId);
            });
            ws.on("message", message => {
                proxyWS.send(JSON.stringify({
                    ws: true,
                    wsId,
                    data: message.toString()
                }))
            })
            proxyWS.on("close", () => {
                proxiedWS.delete(wsId);
            });
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
    return new Promise<any>((resolve, reject) => {
        setTimeout(() => {
            const awaitingPromise = wsReqs.get(reqId);
            if(awaitingPromise) {
                reject();
                wsReqs.delete(reqId);
            }
        }, 1000 * 30) // 30s
        ws.send(JSON.stringify({
            ...data,
            reqId
        }));
        wsReqs.set(reqId, resolve)
    });
}

const activeWS = new Map<string, WebSocket>()
wss.on("connection", async (ws) => {
    const hash = randStr().slice(0, 6);
    activeWS.set(hash, ws);
    ws.on("message", (message) => {
        const rawData = JSON.parse(message.toString());

        if(rawData.ws){
            const proxyWS = proxiedWS.get(rawData.wsId);
            proxyWS.send(rawData.data.toString());
            return;
        }

        const {reqId, data} = rawData;
        const awaitingReq = wsReqs.get(reqId);

        if(!awaitingReq) return;

        awaitingReq(data);
        wsReqs.delete(reqId);
    });
    ws.on("close", () => {
        activeWS.delete(hash);
    });
    if(process.env.PASSWORD){

        let password;
        try{
            password = await awaitReq(ws, {require: "password"});
        }catch (e) { }

        if(password !== process.env.PASSWORD) {
            ws.close();
            return;
        }
    }else if(process.env.AUTH_URL){
        const share_id = randStr();

        const loginURL = process.env.AUTH_URL + (!process.env.AUTH_URL.endsWith("/") ? "/" : "")

        let login;
        try{
            login = await awaitReq(ws, {
                require: "login",
                loginURL: loginURL + `?share=${share_id}`,
                validateURL: process.env.AUTH_URL + process.env.AUTH_VALIDATE_PATH + `?share=${share_id}`
            });
        }catch (e) { }

        if(!login){
            ws.close();
            return;
        }

        let authorized;
        try{
            const response = await fetch(process.env.AUTH_URL + process.env.AUTH_AUTHORIZE_PATH, {
                method: "POST",
                body: login,
                headers: {
                    authorization: process.env.AUTH_SECRET
                }
            });
            if(response.status >= 400)
                authorized = false;
            else
                authorized = await response.text();
        }catch (e){
            authorized = false
        }

        if(!authorized){
            ws.close();
            return;
        }
    }
    ws.send(JSON.stringify({hash}))
})

server.start();

function readBody(req: IncomingMessage) {
    return new Promise((resolve) => {
        let data = "";
        req.on('data', chunk => data += chunk.toString());
        req.on('end', () => resolve(data));
    });
}

function str2ab(str) {
    const buf = new ArrayBuffer(str.length);
    const bufView = new Uint8Array(buf);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return buf;
}

server.addListener({
    prefix: "default",
    async handler(req: IncomingMessage, res: ServerResponse): Promise<any> {
        const host = req.headers.host;
        const firstDomainPart = host.split(".").shift();
        const ws = activeWS.get(firstDomainPart);
        if(!ws) return;

        const body = await readBody(req);

        const {headers, method, url} = req;
        let data;
        try{
            data = await awaitReq(ws, {headers, method, url, body});
        }catch (e) {
            return;
        }

        data.headers.forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.writeHead(data.status);
        res.end(Buffer.from(str2ab(data.body)), 'binary');
    }
}, true);

server.pages["/"].addInBody("<style>html{font-family: sans-serif}</style><h1>FullStacked Share Server</h1>")

setInterval(() => {
    console.log(`${activeWS.size} Active WS | ${proxiedWS.size} Proxied WS | ${wsReqs.size} Awaiting Requests`);
}, 2000);


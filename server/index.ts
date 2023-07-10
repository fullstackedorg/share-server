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

        let login;
        try{
            login = await awaitReq(ws, {
                require: "login",
                loginURL: process.env.AUTH_URL + `?share=${share_id}`,
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

server.addListener({
    prefix: "default",
    async handler(req: IncomingMessage, res: ServerResponse): Promise<any> {
        const host = req.headers.host;
        const firstDomainPart = host.split(".").shift();
        const ws = activeWS.get(firstDomainPart);
        if(!ws) return;

        const {headers, method, url} = req;
        let data;
        try{
            data = await awaitReq(ws, {headers, method, url});
        }catch (e) {
            return;
        }
        data.headers.forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.writeHead(data.status);
        res.end(data.body);
    }
}, true);

server.pages["/"].addInBody("<style>html{font-family: sans-serif}</style><h1>FullStacked Share Server</h1>")

setInterval(() => {
    console.log(`${activeWS.size} Active WS | ${proxiedWS.size} Proxied WS | ${wsReqs.size} Awaiting Requests`);
}, 2000);


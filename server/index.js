'use strict';
const fs = require('fs');
const url = require('url');

const express = require('express');
const WebSocket = require('ws');

const auth = require('./auth');
const wsServer = require('./wsserver');

const app = express();
let server;

 
server = require('https').createServer({
        cert: fs.readFileSync('/etc/letsencrypt/live/domainNameHere/cert.pem', 'utf8'),
        key: fs.readFileSync('/etc/letsencrypt/live/domainNameHere/privkey.pem', 'utf8'),
        ca: fs.readFileSync('/etc/letsencrypt/live/domainNameHere/chain.pem', 'utf8'),
    }, app);
    console.log('Listening for HTTPS 443');
    server.listen(4443, () => {
	console.log('HTTPS Server running on port 443');
});

const exst = express.static(`${__dirname}/../app`);
app.use('/', exst);
if (process.env.INGRESS_PATH) {
    console.log(`Enabling INGRESS_PATH ${process.env.INGRESS_PATH}`);
    app.use(process.env.INGRESS_PATH, exst);
}

const wss = new WebSocket.Server({noServer: true});
function heartbeat() {
    // Mark this socket as alive.
    this.isAlive = true;
}
function noop() {
    // Do nothing.
}
const pinger = setInterval(function ping() {
    // Ping all the clients to see if they're dead.
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) {
            // Dead for a whole cycle, so close.
            return ws.terminate();
        }
        // Mark as dead until we know otherwise.
        ws.isAlive = false;
        ws.ping(noop);
    })
}, 30000);

server.on('upgrade', function upgrade(req, socket, head) {
    // Upgrade all /pubsub connections to WebSocket.
    const pathname = url.parse(req.url).pathname;
    const addr = socket.remoteAddress + ' ' + socket.remotePort;
    if (!pathname.match(/\/pubsub$/)) {
        console.log(addr, 'not connecting to /pubsub');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, function done(ws) {
        ws.isAlive = true;
        ws.on('pong', heartbeat);
        ws.onmessage = function onMessage(event) {
            try {
                const action = JSON.parse(event.data);
                if (action.type === 'MS_SEND') {
                    // kind is either 'publish' or 'subscribe'.
                    auth.authorize(addr, action.meta.channel, action.payload)
                        .then((payload) => {
                            ws.send(JSON.stringify({type: 'MS_RESPONSE', payload: payload, meta: action.meta}));
                            wsServer[payload.kind](addr, action.meta.channel, ws);
                        })
                        .catch((e) => {
                            console.log(addr, 'cannot authorize', e);
                            socket.destroy();
                        });
                    return;
                }
                throw Error('unauthorized');
            } catch (e) {
                console.log(addr, 'error', e, 'handling message', event.data);
                socket.destroy();
            }
        };
        ws.onerror = function onError(event) {
            console.log(addr, 'error', event.message, event.error);
        };
        ws.onclose = function onClose(event) {
            console.log(addr, 'closed');
        };
    });
});

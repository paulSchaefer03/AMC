import { Peer, DataConnection } from "peerjs";
import $ from "jquery";
import { State, Message } from "./types";
import { player} from "./globalConstants";
import { onChunkReceived, onHeaderReceived, onEndOfStreamRecived, onPlayerDurationReceived, onSeekedReceived} from "./receiver";
import { broadcastMediaSourceReady, broadcastReadyToSeek} from "./broadcastFunctions";
import {resetMediaSourceCompletely, updateMediaSourceStateAllPeers, allPeersReadyToSeek} from "./utils";


let state = new State();
let connections = new Map<string, DataConnection>();
const peer = new Peer();

export function initPeer() {
    async function on_data(conn: DataConnection, msg: Message) {
        console.log("Data", conn.peer, msg.type);
    
        switch (msg.type) {
        case "peers":
            console.log("Recv peers", msg.peers);
    
            for (const id of msg.peers) {
            if (connections.has(id)) {
                continue;
            }
            const conn = peer.connect(id);
            on_connect(conn);
            }
            break;
    
        case "state":
            if (State.eq(msg.state, state)) {
            break;
            }
            //Wir verändern den State des Players nur wenn der Buffer in einem Konsistenten Zustand ist
            //Streng genommen muss der Buffer dirkt abgefragt werden
            //await waitForCondition(() => MetaEntryReceiver.length > 1);
            //await waitForCondition(() => msg.state.pos > MetaEntryReceiver[0].start && msg.state.pos < MetaEntryReceiver[MetaEntryReceiver.length - 1].end);
    
            state = msg.state;
    
            player.currentTime = state.pos;
    
            if (!player.paused && !state.play) {
            player.pause();
            }
    
            if (player.paused && state.play) {
            player.play();
            }
            break;
    
        case "chunk":
            onChunkReceived(msg.data);
            break;
        case "header":
            onHeaderReceived(msg.start, msg.end, msg.chunkSize);
            break;
        case "resettingMediaSource":
            if (msg.flag) {
            await resetMediaSourceCompletely();
            broadcastMediaSourceReady(true);
            }
            break;
        case "mediaSourceReady":
            if(msg.flag){
            updateMediaSourceStateAllPeers(msg.flag);
            }
            break;
        case "endOfStream":
            onEndOfStreamRecived(msg.flag);
            break;
        case "playerDuration":
            onPlayerDurationReceived(msg.duration);
            break;
        case "seeked":
            await onSeekedReceived(msg.time);
            broadcastReadyToSeek(true);
            break;
        case "readyToSeek":
            if(msg.flag){
            allPeersReadyToSeek(msg.flag);
            }
            break;
        }
    }

    function on_connect(conn: DataConnection) {
        function update() {
        let peers = "";
        for (let x of connections.keys()) {
            peers += `${x}\n`;
        }
        $("#peers").text(peers);
        }
    
        conn.on("open", () => {
        console.log("Connected to " + conn.peer);
    
        conn.send({
            type: "peers",
            peers: [...connections.keys()],
        });
        connections.set(conn.peer, conn);
        update();
        });
    
        conn.on("close", () => {
        console.log("Disconnected from " + conn.peer);
        connections.delete(conn.peer);
        update();
        });
    
        conn.on("data", (msg) => {
        on_data(conn, msg as Message);
        });
    }
    
    peer.on("open", () => {
        console.log("ID", peer.id);
    
        $("#link").attr("href", `/#${peer.id}`);
    
        if (window.location.hash) {
        const id = window.location.hash.substring(1);
        console.log("Connecting to seed:", id);
    
        const conn = peer.connect(id);
        on_connect(conn);
        }
    });
    
    peer.on("connection", (conn) => {
        console.log("Got connection from ", conn.peer);
    
        on_connect(conn);
    });
}
export function getConnections(): Map<string, DataConnection> {
    return connections;
}
export function getState(): State {
    return state;
}
export function setState(next: State) {
    state = next;
}
import "./style.css";
import { Peer, DataConnection } from "peerjs";
import $ from "jquery";
//test
import { FFmpeg } from '@ffmpeg/ffmpeg';
import {fetchFile, toBlobURL} from '@ffmpeg/util';

let bufferedChunksSender = 0; //Nur für den Sender Relevant
let bufferedChunksReceiver = 0; //Nur für den Empfänger Relevant
let MetaEntryReceiver: MetaEntry[] = []; //Nur für den Empfänger Relevant
let mediaSourceStateAllPeers = [];


async function processVideoChunks(src: string) {
  const ffmpeg = new FFmpeg();
  let loaded = false;
  let chunkCount = 0;
  let meta = "";
  let metaExaktDuration = "";
  let toggel = false;
  if(!loaded){ //Nur einmal laden
  const load = async () => {
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'
    ffmpeg.on('log', ({ message }) => {
        console.log(message);
        const preciseDurationMatch = message.match(/DURATION\s*:\s(\d{2}:\d{2}:\d{2}\.\d{9})/);
        if(preciseDurationMatch){
          if(toggel){
            metaExaktDuration += preciseDurationMatch + "\n";
          }
          toggel = !toggel;
        }
        if (message.includes('Opening')) {
          chunkCount++;
        }
        if (message.includes('Duration: ') && message.includes('start:')) {
          const durationInfo = message.trim();
          meta += durationInfo + "\n";
        }
    });
    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    loaded = true;
  }
  await load();
}
  console.log("Input Blob URL:", src);
  await ffmpeg.writeFile('input.webm', await fetchFile(src));
  const uniqueIdentifier = `video_${Date.now()}`;
await ffmpeg.exec([
    '-i',
    'input.webm',               // Eingabedatei
    '-f',
    'segment',                  // Segmentierungsmodus
    '-segment_time',
    '5',                       // Segmentdauer in Sekunden
    '-g',
    '120',                       // GOP-Größe passend zur Segmentzeit FPS * Segmentzeit
    '-sc_threshold',
    '0',                        // Deaktiviert Szenenwechselerkennung für segmentiertes Encoding
    '-force_key_frames',
    'expr:gte(t,n_forced*5)',  // Erzwingt Keyframes alle 5 Sekunden
    '-reset_timestamps',
    '0',                        // Zurücksetzen der Timestamps pro Segment
    '-map',
    '0',                        // Verwendet die gesamte Eingabe
    '-c:v', 'copy',           // evtl Neukodierung mit VP8
    '-c:a', 'copy',        // evtl Audio mit Vorbis kodieren
    `${uniqueIdentifier}_%03d.webm`          // Ausgabeformat mit 3-stelligem Zähler
]);

for (let i = 0; i < chunkCount; i++) {
  const segmentName = `${uniqueIdentifier}_${String(i).padStart(3, '0')}.webm`;
  console.log(`Extrahiere Metadaten aus ${segmentName}`);

  await ffmpeg.exec([
    '-i', segmentName,
    '-f', 'ffmetadata',
    `metadata.txt`
  ]);
}

  console.log("META", meta);
  console.log("Test Meta", metaExaktDuration);
  const metaEntries = combineMetaAndParse(meta,metaExaktDuration);
  console.log("Meta entries:", metaEntries);
  console.log("Chunks created:", chunkCount);
  return {ffmpeg, chunkCount, metaEntries, uniqueIdentifier};
}

function combineMetaAndParse(meta: string, metaDuration: string): MetaEntry[] {
  const metaLines = meta.trim().split("\n").slice(1); // Ignoriere den ersten Eintrag
  const metaDurationLines = metaDuration
    .trim()
    .split("\n")
    .map((line) => line.match(/DURATION\s*:\s*(\d{2}:\d{2}:\d{2}\.\d{9})/)?.[1])
    .filter((duration) => duration !== undefined) as string[];

  const result: MetaEntry[] = [];

  metaLines.forEach((line, index) => {
    const startMatch = line.match(/start:\s(\d+\.\d+)/);
    const exactDuration = metaDurationLines[index]; // Exakte Duration

    if (startMatch && exactDuration) {
      const start = parseFloat(startMatch[1]);

      // Exakte Duration in Sekunden berechnen
      const durationParts = exactDuration.match(/(\d{2}):(\d{2}):(\d{2}\.\d{9})/);
      if (durationParts) {
        const [, hours, minutes, seconds] = durationParts;
        const durationInSeconds =
          parseFloat(hours) * 3600 + parseFloat(minutes) * 60 + parseFloat(seconds);

        result.push({
          start: start,
          end: durationInSeconds,
        });
      }
    }
  });

  return result;
}

async function loadVideoChunks(ffmpeg: FFmpeg, uniqueIdentifier: string, chunk: number) {
  const chunkStr = chunk.toString().padStart(3, '0');
  const data = await fetchFile(new Blob([(await ffmpeg.readFile(`${uniqueIdentifier}_${chunkStr}.webm`))]));
  return data;
}


class State {
  play: boolean = false;
  pos: number = 0;

  public static eq(a: State, b: State): boolean {
    return a.play === b.play && a.pos === b.pos;
  }
}

interface MetaEntry {
  start: number;
  end: number;
}

interface CurrentBufferSizes {
  chunkSizes: number[];
  totalBufferSize: number;
}

type PeersMessage = {
  type: "peers";
  peers: Array<string>;
};

type StateMessage = {
  type: "state";
  state: State;
};

type ChunkMessage = {
  type: "chunk";
  data: Uint8Array;
};

type HeaderMessage = {
  type: "header";
  start: number;
  end: number;
};

type ResettingMediaSource = {
  type: "resettingMediaSource";
  flag: boolean;
};

type MediaSourceReady = {
  type: "mediaSourceReady";
  flag: boolean;
}

type EndOfStream = {
  type: "endOfStream";
  flag: boolean;
}

type Message = PeersMessage | StateMessage | ChunkMessage | HeaderMessage | ResettingMediaSource | MediaSourceReady | EndOfStream;

let state = new State();

let connections = new Map<string, DataConnection>();

const peer = new Peer();

const MAX_BUFFER_SIZE = 100 * 1024 * 1024; // 100 MB
const chunkSize = 256 * 1024;

let currentBufferSize: CurrentBufferSizes = {chunkSizes: [], totalBufferSize: 0};

let resolveCondition: (() => void) | null = null;

const player = document.querySelector("#video")! as HTMLVideoElement;
const defaultVideoURL = "https://box.open-desk.net/Big Buck Bunny [YE7VzlLtp-4].mp4";

let mediaSource = new MediaSource();
let sourceBuffer: SourceBuffer;
let bufferQueue: Uint8Array[] = []; // Warteschlange für Chunks

// Default source
player.src = defaultVideoURL;
// Fallback
player.addEventListener("error", () => {
  console.error("Error loading video. Using default source.");
  player.src = defaultVideoURL;
});

function canAddToBuffer(chunkSize: number): boolean {
  return currentBufferSize.totalBufferSize + chunkSize <= MAX_BUFFER_SIZE;
}

function updateBufferSize(change: number, addToLocalChunk: boolean, addNewChunk: boolean): void {
  if (addToLocalChunk) {
    currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1] += change;
    currentBufferSize.totalBufferSize += change;
    triggerConditionCheck();
  }
  else if(!addToLocalChunk && !addNewChunk){ 
    currentBufferSize.totalBufferSize -= currentBufferSize.chunkSizes[0];
    currentBufferSize.chunkSizes.shift();
  }
  else if(addNewChunk){
    currentBufferSize.chunkSizes.push(change);
    currentBufferSize.totalBufferSize += change;
  }
  console.log(`Buffer size updated: ${currentBufferSize.totalBufferSize} bytes`, currentBufferSize.chunkSizes);
}

function updateMediaSourceStateAllPeers(flag: boolean) {
  mediaSourceStateAllPeers.push(flag);
  triggerConditionCheck();
}

mediaSource.addEventListener("sourceopen", () => {
  const mimeCodec = 'video/webm; codecs="vp8, vorbis"';
  if (!MediaSource.isTypeSupported(mimeCodec)) {
    console.error("Unsupported MIME type or codec:", mimeCodec);
    return;
  }
  sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

sourceBuffer.addEventListener("updateend", () => {
  console.log("Buffer updated, processing next chunk.");

  processBufferQueue(); // Verarbeite weitere Chunks
});
});

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
      onHeaderReceived(msg.start, msg.end);
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

function broadcast_state() {
  const next = new State();
  next.play = !player.paused;
  next.pos = player.currentTime;

  if (State.eq(state, next)) {
    return;
  }

  state = next;

  const msg = {
    type: "state",
    state: state,
  };

  for (const conn of connections.values()) {
    conn.send(msg);
  }
}

function onHeaderReceived(start: number, end: number) {
  MetaEntryReceiver.push({start: start, end: end});
  updateBufferSize(0, false, true);
  bufferedChunksReceiver++;
}

function onChunkReceived(chunk: Uint8Array) {
  if (!sourceBuffer || mediaSource.readyState !== "open") {
    console.warn("SourceBuffer or MediaSource not ready. Resetting.");
    return;
  }

  bufferQueue.push(chunk); // Chunk zur Warteschlange hinzufügen
  console.log("received chunk", chunk.length);
  processBufferQueue();
}

async function processBufferQueue() {
  console.log("Processing buffer queue...");
  if (!sourceBuffer) {
    console.warn("SourceBuffer is not initialized.");
    return;
  }

  if (sourceBuffer.updating) {
    console.log("SourceBuffer is updating.");
    let timeForUpdate = await waitForEventOrCondition(sourceBuffer, "updateend", () => !sourceBuffer.updating);
    console.log("SourceBuffer update completed in ", timeForUpdate, "ms");
  }

  if (bufferQueue.length === 0) {
    console.log("Buffer queue is empty.");
    return;
  }

  const chunk = bufferQueue.shift()!;
  try {
    sourceBuffer.appendBuffer(chunk);
    updateBufferSize(chunk.byteLength, true, false);    
    console.log("Chunk appended successfully:", chunk.byteLength, "bytes in buffer:", currentBufferSize );

  } catch (error) {
    console.error("Error appending buffer:", error);
    bufferQueue.unshift(chunk); // Füge den Chunk zurück in die Warteschlange
    setTimeout(() => processBufferQueue(), 100); // Versuche es später erneut
  }
}

document.querySelector("#play")?.addEventListener("click", async (event) => {
  event.preventDefault();
  //processVideo();
  const fileInput = document.querySelector("#file") as HTMLInputElement;
  const file = fileInput?.files?.item(0);
  
  if (!file) {
    console.warn("No file selected. Using default video source.");
    player.src = defaultVideoURL; // Fallback URL
    player.play();
    return;
  }
  let blobSource = URL.createObjectURL(new Blob([file], { type: 'video/webm' }))
  console.log("Streaming file:", file.name, "Blob URL:", blobSource);
  let result = await processVideoChunks(blobSource)
  let totalNumberOfChunks = result.chunkCount;
  let MediaMetadata = result.metaEntries;
  let uniqueIdentifier = result.uniqueIdentifier;
  let ffmpeg = result.ffmpeg;
  broadcastResettingMediaSource(true);
  // Warte das alle Teilnehmer die Mediasource zurückgesetzt haben
  console.log("Waiting for all peers to reset MediaSource...");
  const waitForMediaSourceReady = await waitForCondition(() => mediaSourceStateAllPeers.length === connections.size + 1);//Der Initator wird nicht als Peer gezählt deshalb +1
  console.log("All peers are ready to reset MediaSource.", mediaSourceStateAllPeers.length, " === ",connections.size + 1, " Time:", waitForMediaSourceReady);

  //Frage länge von sourcebuffer.buffered ab, solange weniger als 5 Chunks im Buffer sind lade weitere Chunks
 let lokalIndexForChunks = 0;  //Nur für den Sender Relevant
 bufferedChunksSender = 0;       //Nur für den Sender Relevant
 while(lokalIndexForChunks < totalNumberOfChunks || bufferedChunksSender < 6){ {
    console.log("Buffered chunks:", bufferedChunksSender);
    if(bufferedChunksSender >= 5){ 
      const timeToLoadNewChunks = await waitForCondition(() => bufferedChunksSender < 5);
      console.log("Time to load new chunks:", timeToLoadNewChunks);
      continue;
    }
    const chunkData = await loadVideoChunks(ffmpeg, uniqueIdentifier, lokalIndexForChunks);
    broadcastHeader(MediaMetadata[lokalIndexForChunks].start, MediaMetadata[lokalIndexForChunks].end);
    startSendingChunks(chunkData);
    lokalIndexForChunks++;
    bufferedChunksSender++;
    const zwsTimeResolve = await waitForCondition(() => currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1] === chunkData.byteLength);
    console.log("Video chunk length:", chunkData.byteLength, " Buffered chunk sizes:", currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1], "Time:", zwsTimeResolve);
    if(lokalIndexForChunks >= totalNumberOfChunks){
      broadcastEndOfStream(true);
      break;
    }
  }
}
});

async function startSendingChunks(data: Uint8Array) {
  while(data.byteLength > 0){
    console.log("Data Chunk File:", data);
    const chunk = data.slice(0, chunkSize);
    data = data.slice(chunkSize);
    console.log("Data Chunk File removed:", data, "Chunk:", chunk); 
  
    if (!canAddToBuffer(chunk.byteLength)) {
      console.warn(
        `Cannot add chunk of size ${chunk.byteLength}. Buffer limit of ${MAX_BUFFER_SIZE} bytes reached.`
      );
      return;
    }
    if (bufferQueue.length > 100) { //Sollte nicht vorkommen deshalb auch nicht Overengineered
      console.log("Buffer queue full. Waiting before loading more chunks...");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    broadcastChunk(chunk);
  };
}



function broadcastChunk(chunk: Uint8Array) {
  //local append
  console.log("Appending chunk locally for the initiator.");
  onChunkReceived(chunk);

  //Broadcast chunk to all connected peers
  for (const conn of connections.values()) {
    console.log(`Sending chunk to peer: ${conn.peer}`);
    conn.send({
      type: "chunk",
      data: chunk,
    });
  }
}

function broadcastHeader(start : number, end: number) {
  //local append
  console.log("Appending header locally for the initiator.");
  onHeaderReceived(start, end);
  
  for (const conn of connections.values()) {
    console.log(`Sending chunk to peer: ${conn.peer}`);
    conn.send({
      type: "header",
      start: start,
      end: end
    });
  }
}

function broadcastEndOfStream(flag: boolean) {
  //local append
  console.log("Ending Stream locally for the initiator.");
  onEndOfStreamRecived(flag);
  
  for (const conn of connections.values()) {
    console.log(`Sending chunk to peer: ${conn.peer}`);
    conn.send({
      type: "endOfStream",
      flag: flag
    });
  }
}

async function onEndOfStreamRecived(flag: boolean) {
  if (flag) {
    if (mediaSource.readyState !== "open") {
      console.warn("MediaSource is not open. Cannot end stream.");
      return;
    }
    if (sourceBuffer.updating) {
      console.log("SourceBuffer is updating.");
      let timeForUpdate = await waitForEventOrCondition(sourceBuffer, "updateend", () => !sourceBuffer.updating);
      console.log("SourceBuffer update completed in ", timeForUpdate, "ms");
    }
    console.log("Ending MediaSource stream.");
    mediaSource.endOfStream();
  }
}

async function broadcastResettingMediaSource(flag: boolean) {
  //local reset
  console.log("Resetting MediaSourceAllPeers");
  mediaSourceStateAllPeers = [];

  for (const conn of connections.values()) {
    conn.send({
      type: "resettingMediaSource",
      flag: flag,
    });
  }
  
  //MediaSource resetten für den Initiator
  console.log("Resetting Mediasource for the initiator.");
  await resetMediaSourceCompletely();
  updateMediaSourceStateAllPeers(true);
}

function broadcastMediaSourceReady(flag: boolean) {
  for (const conn of connections.values()) {
    conn.send({
      type: "mediaSourceReady",
      flag: flag,
    });
  }
}

async function resetMediaSourceCompletely() {
  if (mediaSource.readyState === "open") {
    try {
      mediaSource.endOfStream();
      console.log("MediaSource stream ended.");
    } catch (err) {
      console.warn("Error ending MediaSource stream:", err);
    }
  }

  // Remove the existing sourceBuffer if it exists
  if (sourceBuffer) {
    try {
      mediaSource.removeSourceBuffer(sourceBuffer);
      console.log("SourceBuffer removed.");
    } catch (err) {
      console.warn("Error removing SourceBuffer:", err);
    }
  }

  // Create a new MediaSource
  mediaSource = new MediaSource();
  bufferQueue = []; // Clear buffer queue

  player.src = URL.createObjectURL(mediaSource);

  return new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        const mimeCodec = 'video/webm; codecs="vp8, vorbis"';
        if (!MediaSource.isTypeSupported(mimeCodec)) {
          console.error("Unsupported MIME type or codec:", mimeCodec);
          reject(new Error("Unsupported MIME type or codec"));
          return;
        }

        try {
          sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
          sourceBuffer.addEventListener("updateend", () => {
            //TEST
            //console.log("Buffer updated, processing next chunk.");
            //processBufferQueue();
          });
          console.log("MediaSource and SourceBuffer are ready.");
          resolve();
        } catch (err) {
          console.error("Error creating SourceBuffer:", err);
          reject(err);
        }
      },
      { once: true } 
    );

    mediaSource.addEventListener(
      "sourceclose",
      () => {
        console.log("MediaSource was closed unexpectedly.");
        reject(new Error("MediaSource closed unexpectedly"));
      },
      { once: true }
    );
  });
}
player.addEventListener("timeupdate", async () => {
  if(MetaEntryReceiver.length >= 5 && 
    (bufferedChunksReceiver - MetaEntryReceiver.length) >= 0){//Inital 5 Chunks abwarten bevor irgendwas gemacht wird
    if(player.currentTime > MetaEntryReceiver[bufferedChunksReceiver-4].end){ //Ende des ersten Segments sodass nullte segment entfert werden kann und ein neues geladen wird
      console.log(`Current time updated: ${player.currentTime}`, MetaEntryReceiver[bufferedChunksReceiver-5].end);
      await removeChunkFromSourceBuffer();
      decrementBufferedChunksSender(); //Recht für den Sender aus braucht der Empfänger nicht
      bufferedChunksReceiver--;
      console.log("Buffered chunks:", bufferedChunksSender);
      MetaEntryReceiver.shift();
    }
  }
});

function removeChunkFromSourceBuffer() {
  return new Promise<void>(async (resolve, reject) => {
    if (sourceBuffer.updating) {
      console.log("SourceBuffer is updating.");
      let timeForUpdate = await waitForEventOrCondition(sourceBuffer, "updateend", () => !sourceBuffer.updating);
      console.log("SourceBuffer update completed in ", timeForUpdate, "ms");
    }
    try {
      console.log("Removing first chunk from SourceBuffer");
      sourceBuffer.remove(MetaEntryReceiver[bufferedChunksReceiver-5].start, MetaEntryReceiver[bufferedChunksReceiver-5].end);
      updateBufferSize(currentBufferSize.chunkSizes[0], false, false); //Entferne den ersten Chunk aus dem Buffer
      sourceBuffer.addEventListener("updateend", () => {
        console.log("Chunk removed successfully.");
        resolve();
      }, { once: true });
    } catch (error) {
      console.error("Error removing buffer:", error);
      setTimeout(() => removeChunkFromSourceBuffer().then(resolve).catch(reject), 100);
    }
  });
}

function waitForCondition(condition: () => boolean): Promise<number> {
  const startTime = performance.now();
  return new Promise((resolve) => {
    const checkCondition = () => {
      if (condition()) {
        const endTime = performance.now();
        resolve(endTime - startTime); // Bedingung erfüllt, auflösen
      } else {
        resolveCondition = () => {
          if (condition()) {
            const endTime = performance.now();
            resolve(endTime - startTime); // Beim nächsten Trigger prüfen
            resolveCondition = null; // Zurücksetzen
          }
        };
      }
    };
    checkCondition();
  });

}

function waitForEventOrCondition(
  target: EventTarget, 
  eventName: string, 
  condition: () => boolean
): Promise<number> {
  const startTime = performance.now();
  return new Promise((resolve) => {
    const eventHandler = () => {
      if (condition()) {
        target.removeEventListener(eventName, eventHandler);
        const endTime = performance.now();
        resolve(endTime - startTime);
      }
    };

    if (condition()) {
      const endTime = performance.now();
      resolve(endTime - startTime);
    } else {
      target.addEventListener(eventName, eventHandler);
    }
  });
}

function triggerConditionCheck() {
  if (resolveCondition) {
    resolveCondition();
  }
}

function decrementBufferedChunksSender() {
  bufferedChunksSender--;
  triggerConditionCheck();
}

player.addEventListener("play", () => {
  console.log("Player is playing.");
  broadcast_state();
});

player.addEventListener("pause", () => {
  console.log("Player is paused.");
  broadcast_state();
});
player.addEventListener("seeked", () => broadcast_state());

window.addEventListener("resize", () => {
  const videoContainer = document.querySelector(".video-container") as HTMLDivElement;
  if (videoContainer) {
    const aspectRatio = 16 / 9;
    const width = Math.min(window.innerWidth * 0.9, 800);
    videoContainer.style.width = `${width}px`;
    videoContainer.style.height = `${width / aspectRatio}px`;
  }
});
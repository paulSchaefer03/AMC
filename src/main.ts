import "./style.css";
import { Peer, DataConnection } from "peerjs";
import $ from "jquery";
//test
import { FFmpeg } from '@ffmpeg/ffmpeg';
import {fetchFile, toBlobURL} from '@ffmpeg/util';
//TODO Komische douple seeking Events vom Player verhindern


let bufferedBytesSender = 0; //Nur für den Sender Relevant
let MetaEntryReceiver: MetaEntry[] = []; //Nur für den Empfänger Relevant
let mediaSourceStateAllPeers = [];
let seekedStateAllPeers = [];
let lokalIndexForChunksSender = 0; //Nur für den Sender Relevant
let MediaMetadata: MetaEntry[] = [];
const MAX_BUFFER_SIZE = 25 * 1024 * 1024; // 25 MB
const chunkSize = 256 * 1024; // 256 KB
//const mimeCodec = 'video/webm; codecs="av01.0.08M.08, opus"'; // AV1 Codec
const mimeCodec = 'video/webm; codecs="vp8, vorbis"'; // VP8 Codec
//const mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'; // H.264 Codec
//Wenn man das effizenter Macht sollte man SEHR große Videos laden können
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
    'input.webm',             // Eingabedatei
//    '-pix_fmt', 'yuv420p',     // Pixel-Format 
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

const chunkSizes = [];
for (let i = 0; i < chunkCount; i++) {
  const segmentName = `${uniqueIdentifier}_${String(i).padStart(3, '0')}.webm`;
  console.log(`Extrahiere Metadaten aus ${segmentName}`);
  
  const chunkFile = await fetchFile(new Blob([(await ffmpeg.readFile(segmentName))]));
  const chunkSize = chunkFile.byteLength;
  chunkSizes.push(chunkSize);

  await ffmpeg.exec([
    '-i', segmentName,
    '-f', 'ffmetadata',
    `metadata.txt`
  ]);
}

  console.log("META", meta);
  console.log("Test Meta", metaExaktDuration);
  const metaEntries = combineMetaAndParse(meta,metaExaktDuration, chunkSizes);
  console.log("Meta entries:", metaEntries);
  console.log("Chunks created:", chunkCount);
  return {ffmpeg, chunkCount, metaEntries, uniqueIdentifier};
}

function combineMetaAndParse(meta: string, metaDuration: string, chunkSizes: number[]): MetaEntry[] {
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
          byteLength: chunkSizes[index],
        });
      }
    }
  });

  return result;
}

async function loadVideoChunks(ffmpeg: FFmpeg, uniqueIdentifier: string, chunk: number, header: boolean = false): Promise<Uint8Array> {
  if(!header){
  const chunkStr = chunk.toString().padStart(3, '0');
  const data = await fetchFile(new Blob([(await ffmpeg.readFile(`${uniqueIdentifier}_${chunkStr}.webm`))]));
  return data;
  }else{
    const data = await fetchFile(new Blob([(await ffmpeg.readFile(`init_header_${uniqueIdentifier}.webm`))]));
    return data;
  }
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
  byteLength: number;
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

type PlayerDuration = {
  type: "playerDuration";
  duration: number;
};

type HeaderMessage = {
  type: "header";
  start: number;
  end: number;
  chunkSize: number;
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

type Seeked = {
  type: "seeked";
  time: number;
}

type ReadyToSeek = {
  type: "readyToSeek";
  flag: boolean;
}

type Message = PeersMessage | StateMessage | ChunkMessage | HeaderMessage | ResettingMediaSource | MediaSourceReady | EndOfStream | PlayerDuration | Seeked | ReadyToSeek;

let state = new State();

let connections = new Map<string, DataConnection>();

const peer = new Peer();

let currentBufferSize: CurrentBufferSizes = {chunkSizes: [], totalBufferSize: 0};

let resolveCondition: (() => void) | null = null;

const player = document.querySelector("#video")! as HTMLVideoElement;
const defaultVideoURL = "https://box.open-desk.net/Big Buck Bunny [YE7VzlLtp-4].mp4";
//const defaultVideoURL = "https://ftp.nluug.nl/pub/graphics/blender/demo/movies/ToS/tearsofsteel_4k.mov";

let mediaSource = new MediaSource();
let sourceBuffer: SourceBuffer;
let bufferQueue: Uint8Array[] = []; // Warteschlange für Chunks

// Default source
player.src = defaultVideoURL;

function canAddToBuffer(chunkSize: number): boolean {
  return currentBufferSize.totalBufferSize + chunkSize <= MAX_BUFFER_SIZE;
}

function updateBufferSize(change: number, addToLocalChunk: boolean, addNewChunk: boolean, removeAllChunks: boolean): void {
  if (addToLocalChunk) {//Small Chunks
    currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1] += change;
    currentBufferSize.totalBufferSize += change;
    triggerConditionCheck();
  }
  else if(!addToLocalChunk && !addNewChunk && !removeAllChunks){ 
    currentBufferSize.totalBufferSize -= change;
    currentBufferSize.chunkSizes.shift();
  }
  else if(addNewChunk){
    currentBufferSize.chunkSizes.push(change);
    currentBufferSize.totalBufferSize += change;
  }
  else if(removeAllChunks){
    console.log("Remove all chunks from buffer and Resetting Variables");
    currentBufferSize.chunkSizes = [];
    currentBufferSize.totalBufferSize = 0;
    MetaEntryReceiver = [];
  }
  console.log(`Buffer size updated: ${currentBufferSize.totalBufferSize} bytes`, currentBufferSize.chunkSizes);
}

function updateMediaSourceStateAllPeers(flag: boolean) {
  mediaSourceStateAllPeers.push(flag);
  triggerConditionCheck();
}

function allPeersReadyToSeek(flag: boolean) {
  seekedStateAllPeers.push(flag);
  triggerConditionCheck();
}

mediaSource.addEventListener("sourceopen", () => {
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

async function onPlayerDurationReceived(duration: number) {
  if (!sourceBuffer || mediaSource.readyState !== "open") {
    console.warn("SourceBuffer or MediaSource not ready. Can not set player duration.");
    await waitForEventOrCondition(sourceBuffer, "updateend", () => !sourceBuffer.updating);
  }
  mediaSource.duration = duration;
}

function onHeaderReceived(start: number, end: number, chunkSize: number) {
  MetaEntryReceiver.push({start: start, end: end, byteLength: chunkSize});
  updateBufferSize(0, false, true, false);
}

function onChunkReceived(chunk: Uint8Array) {
  if(!bufferQueue){
    console.warn("BufferQueue not initialized");
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
  if (!mediaSource) {
    console.warn("MediaSource is not initialized.");
    return;
  }
  if (mediaSource.readyState !== "open") {
    console.warn("MediaSource is not open. Cannot process buffer queue.");
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
    updateBufferSize(chunk.byteLength, true, false, false);    
    console.log("Chunk appended successfully:", chunk.byteLength, "bytes in buffer:", currentBufferSize );

  } catch (error) {
    console.error("Error appending buffer:", error);
    bufferQueue.unshift(chunk); // Füge den Chunk zurück in die Warteschlange
    return;
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
  MediaMetadata = result.metaEntries;
  let uniqueIdentifier = result.uniqueIdentifier;
  let ffmpeg = result.ffmpeg;
  broadcastResettingMediaSource(true);
  // Warte das alle Teilnehmer die Mediasource zurückgesetzt haben
  console.log("Waiting for all peers to reset MediaSource...");
  const waitForMediaSourceReady = await waitForCondition(() => mediaSourceStateAllPeers.length === connections.size + 1);//Der Initator wird nicht als Peer gezählt deshalb +1
  console.log("All peers are ready to reset MediaSource.", mediaSourceStateAllPeers.length, " === ",connections.size + 1, " Time:", waitForMediaSourceReady);
  console.log("Broadcasting player duration:", MediaMetadata[MediaMetadata.length-1].end);
  broadcastPlayerDuration(MediaMetadata[MediaMetadata.length-1].end);
  //Frage länge von sourcebuffer.buffered ab, solange weniger als 5 Chunks im Buffer sind lade weitere Chunks
 lokalIndexForChunksSender = 0;  //Nur für den Sender Relevant
 bufferedBytesSender = 0;       //Nur für den Sender Relevant
 while(lokalIndexForChunksSender < totalNumberOfChunks || (bufferedBytesSender + MediaMetadata[lokalIndexForChunksSender].byteLength) < MAX_BUFFER_SIZE){ {
    console.log("Buffered chunks:", bufferedBytesSender);
    if((bufferedBytesSender + MediaMetadata[lokalIndexForChunksSender].byteLength) >= MAX_BUFFER_SIZE){ 
      const timeToLoadNewChunks = await waitForCondition(() => (bufferedBytesSender + MediaMetadata[lokalIndexForChunksSender].byteLength) < MAX_BUFFER_SIZE);
      console.log("Time to load new chunks:", timeToLoadNewChunks);
      continue;
    }
    const chunkData = await loadVideoChunks(ffmpeg, uniqueIdentifier, lokalIndexForChunksSender);
    broadcastHeader(MediaMetadata[lokalIndexForChunksSender].start, MediaMetadata[lokalIndexForChunksSender].end, MediaMetadata[lokalIndexForChunksSender].byteLength);
    startSendingChunks(chunkData);
    bufferedBytesSender += MediaMetadata[lokalIndexForChunksSender].byteLength;
    lokalIndexForChunksSender++;
    const zwsTimeResolve = await waitForCondition(() => currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1] === chunkData.byteLength);
    console.log("Video chunk length:", chunkData.byteLength, " Buffered chunk sizes:", currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1], "Time:", zwsTimeResolve);
    if(lokalIndexForChunksSender >= totalNumberOfChunks){
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

function broadcastPlayerDuration(duration: number) {
  //local append
  console.log("Set duration locally for the initiator.");
  onPlayerDurationReceived(duration);
  
  for (const conn of connections.values()) {
    console.log(`Sending chunk to peer: ${conn.peer}`);
    conn.send({
      type: "playerDuration",
      duration: duration,
    });
  }
}

function broadcastHeader(start : number, end: number, chunkSize: number) {
  //local append
  console.log("Appending header locally for the initiator.");
  onHeaderReceived(start, end, chunkSize);
  
  for (const conn of connections.values()) {
    console.log(`Sending chunk to peer: ${conn.peer}`);
    conn.send({
      type: "header",
      start: start,
      end: end,
      chunkSize: chunkSize
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

//Wenn seeked außerhalb des Buffers ist wird der Buffer geleert(Komplett)
//Suche VideoSegment welches am nächsten an der seeked Position ist und lade dieses
//Setzte Variablen fürs Streaming auf neue Werte
//!!!!!!!ENDING MEDIA SOURCE PORBLEM!!!!!!!!!!!!
async function onSeekedReceived(currentTime: number): Promise<void> {
  console.log("Seeked received:", currentTime);
  if (MetaEntryReceiver.length < 1) {
    console.log("No MetaEntries available. Cannot seek.");
    return;
  }
  if (currentTime > MetaEntryReceiver[0].start && currentTime < MetaEntryReceiver[MetaEntryReceiver.length - 1].end) {
    console.log("Seeked position is within the buffered range.");
    return;
  }
  console.log("Seeked position is outside the buffered range. Clear Buffer");
  await removeAllChunksFromSourceBuffer();
  // Zurückgesetzt werden MetaEntryReceiver,
  // currentBufferSize(chunkSizes, totalBufferSize)
  console.log("Buffer cleared. Seeking to new position.");
  // zu verändernde Variablen bufferedBytesSender, lokalIndexForChunksSender
  if (MediaMetadata.length < 1) {
    console.log("No MetaEntries available. Cannot seek.");
    return;
  }

  let targetIndex = -1;
  for (let i = 0; i < MediaMetadata.length; i++) {
    if (currentTime >= MediaMetadata[i].start && currentTime <= MediaMetadata[i].end) {
      console.log("Seeked position:", currentTime, "Segment start:", MediaMetadata[i].start, "Segment end:", MediaMetadata[i].end);
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    console.log("No suitable segment found for the seeked position.");
    return;
  }
  lokalIndexForChunksSender = targetIndex;
  //An diesem Punkt muss es sich um den Sender handeln
  //RESET bufferedBytesSender: Triggered, dass von neuem gesendet wird
  //Erst wenn alle anderen Peers in einem Konsistenten Zustand sind
  //Initator ist zu diesem Punkt schon in einem Konsistenten Zustand d.h. nur connections.size
  if (connections.size > 0) {  
    const waitForSeekReady = await waitForCondition(() => allPeersReadyToSeek.length === connections.size);
    console.log("All peers are ready to seek.", allPeersReadyToSeek.length, " === ", connections.size, " Time:", waitForSeekReady);
  }
  seekedStateAllPeers = []; //Alle Peers sind bereit zum Seeken zurücksetzen
  decrementbufferedBytesSender(true, 0);
  
}

async function broadcastSeeked(currentTime: number) {
  seekedStateAllPeers = [];
  for (const conn of connections.values()) {
    conn.send({
      type: "seeked",
      time: currentTime,
    });
  }
  console.log("Set seeked Position for Initator");
  await onSeekedReceived(currentTime);
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

function broadcastReadyToSeek(flag: boolean) {
  for (const conn of connections.values()) {
    conn.send({
      type: "readyToSeek",
      flag: flag,
    });
  }
}

async function resetMediaSourceCompletely() {
  //Setzte Variablen fürs Streaming auf Empfängeseite zurück
  MetaEntryReceiver = [];
  seekedStateAllPeers = [];
  updateBufferSize(0, false, false, true);
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
  if(MetaEntryReceiver.length > 1){//Inital mindestens 2 Segmente
    if(player.currentTime > MetaEntryReceiver[1].end){ //Ende des 2. Segments sodaaß das 1. Segment entfernt werden kann
      console.log(`Current time updated: ${player.currentTime}`, MetaEntryReceiver[0].end);
      await removeChunkFromSourceBuffer();
      decrementbufferedBytesSender(false, MetaEntryReceiver[0].byteLength); //Recht für den Sender aus braucht der Empfänger nicht
      console.log("Buffered chunks:", bufferedBytesSender);
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
      console.log("Removing first chunk from SourceBuffer", MetaEntryReceiver[0].start, MetaEntryReceiver[0].end);
      sourceBuffer.remove(MetaEntryReceiver[0].start, MetaEntryReceiver[0].end);
      updateBufferSize(MetaEntryReceiver[0].byteLength, false, false, false); //Entferne den ersten Chunk aus dem Buffer
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

async function removeAllChunksFromSourceBuffer(): Promise<void> {
  console.log("MetaEntryReceiver: ", MetaEntryReceiver);
  for (let i = 0; i < MetaEntryReceiver.length; i++) {
    if (sourceBuffer.updating) {
      console.log("SourceBuffer is updating.");
      let timeForUpdate = await waitForEventOrCondition(sourceBuffer, "updateend", () => !sourceBuffer.updating);
      console.log("SourceBuffer update completed in ", timeForUpdate, "ms");
    }
    try {
      sourceBuffer.remove(MetaEntryReceiver[i].start, MetaEntryReceiver[i].end);
      console.log("Removing ", i, "chunk from SourceBuffer");
      await waitForEventOrCondition(sourceBuffer, "updateend", () => !sourceBuffer.updating);
    } catch (error) {
      console.error("Error removing buffer:", error);
      setTimeout(() => removeAllChunksFromSourceBuffer(), 100);
    }
  }
  updateBufferSize(0, false, false, true);
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

function decrementbufferedBytesSender(reset: boolean = false, chunkSize: number) {
  if(reset){
    bufferedBytesSender = 0;
  }
  else{
    bufferedBytesSender -= chunkSize;
  }
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

player.addEventListener("seeking", () => {
  console.log("Player try to seeked to:", player.currentTime);
  seekedStateAllPeers = [];
  broadcast_state();
  broadcastSeeked(player.currentTime);
});

window.addEventListener("resize", () => {
  const videoContainer = document.querySelector(".video-container") as HTMLDivElement;
  if (videoContainer) {
    const aspectRatio = 16 / 9;
    const width = Math.min(window.innerWidth * 0.9, 800);
    videoContainer.style.width = `${width}px`;
    videoContainer.style.height = `${width / aspectRatio}px`;
  }
});
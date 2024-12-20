import { processVideoChunks, loadVideoChunks } from "./setupFileStreaming";
import { player, defaultVideoURL, chunkSize, MAX_BUFFER_SIZE } from "./globalConstants";
import {MetaEntry} from "./types"
import { broadcastResettingMediaSource, broadcastPlayerDuration, broadcastHeader, broadcastChunk, broadcastEndOfStream } from "./broadcastFunctions";
import { getCurrentBufferSize, getBufferQueue, getMediaSourceStateAllPeers } from "./receiver";
import { waitForCondition, canAddToBuffer } from "./utils";
import { getConnections } from "./peer";

let MediaMetadata: MetaEntry[] = [];
let bufferedBytesSender = 0;
let lokalIndexForChunksSender = 0;

export function initSender(){
    document.querySelector("#play")?.addEventListener("click", async (event) => {
        event.preventDefault();
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
        const waitForMediaSourceReady = await waitForCondition(() => getMediaSourceStateAllPeers().length === getConnections().size + 1);//Der Initator wird nicht als Peer gezählt deshalb +1
        console.log("All peers are ready to reset MediaSource.", getMediaSourceStateAllPeers().length, " === ",getConnections().size + 1, " Time:", waitForMediaSourceReady);
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
          let currentBufferSize = getCurrentBufferSize();
          const zwsTimeResolve = await waitForCondition(() => currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1] === chunkData.byteLength);
          console.log("Video chunk length:", chunkData.byteLength, " Buffered chunk sizes:", currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1], "Time:", zwsTimeResolve);
          if(lokalIndexForChunksSender >= totalNumberOfChunks){
            broadcastEndOfStream(true);
            break;
          }
        }
      }
    });
}

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
      if (getBufferQueue().length > 100) { //Sollte nicht vorkommen deshalb auch nicht Overengineered
        console.log("Buffer queue full. Waiting before loading more chunks...");
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      broadcastChunk(chunk);
    };
  }

export function setBufferedBytesSender(newBufferedBytesSender: number) {
    bufferedBytesSender = newBufferedBytesSender;
}
export function getBufferedBytesSender(): number {
    return bufferedBytesSender;
}
export function getMediaMetadata(): MetaEntry[] {
    return MediaMetadata;
}
export function setMediaMetadata(newMediaMetadata: MetaEntry[]) {
    MediaMetadata = newMediaMetadata;
}
export function setLokalIndexForChunksSender(newLokalIndexForChunksSender: number) {
    lokalIndexForChunksSender = newLokalIndexForChunksSender;
}
export function getLokalIndexForChunksSender(): number {
    return lokalIndexForChunksSender;
}

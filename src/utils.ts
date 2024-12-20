import { getMetaEntryReceiver, setMetaEntryReceiver } from "./receiver";
import { player, mimeCodec, MAX_BUFFER_SIZE } from "./globalConstants";
import { getMediaSource, setMediaSource, getSourceBuffer, 
    setSourceBuffer, setBufferQueue, getCurrentBufferSize, setCurrentBufferSize,
setSeekedStateAllPeers, setMediaSourceStateAllPeers, getMediaSourceStateAllPeers,
getSeekedStateAllPeers} from "./receiver";
import { setBufferedBytesSender, getBufferedBytesSender } from "./sender";


let resolveCondition: (() => void) | null = null;

export function updateMediaSourceStateAllPeers(flag: boolean) {
  setMediaSourceStateAllPeers([...getMediaSourceStateAllPeers(), flag]);
  triggerConditionCheck();
}

export function allPeersReadyToSeek(flag: boolean) {
  setSeekedStateAllPeers([...getSeekedStateAllPeers(), flag]);
  triggerConditionCheck();
}

export function waitForCondition(condition: () => boolean): Promise<number> {
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
  
export function waitForEventOrCondition(
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

export function triggerConditionCheck() {
    if (resolveCondition) {
      resolveCondition();
    }
}

export async function resetMediaSourceCompletely(): Promise<void> {
  //Setzte Variablen fürs Streaming auf Empfängeseite zurück
  setMetaEntryReceiver([]);
  setSeekedStateAllPeers([]);
  let mediaSource = getMediaSource();
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
  let sourceBuffer = getSourceBuffer();
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
  setBufferQueue([]); // Clear buffer queue

  player.src = URL.createObjectURL(mediaSource);

  return new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (!MediaSource.isTypeSupported(mimeCodec)) {
          console.error("Unsupported MIME type or codec:", mimeCodec);
          reject(new Error("Unsupported MIME type or codec"));
          setMediaSource(mediaSource);
          return;
        }

        try {
          sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
          //evtl Probleme mit dem SourceBuffer
          setMediaSource(mediaSource);
          setSourceBuffer(sourceBuffer);
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

export function updateBufferSize(change: number, addToLocalChunk: boolean, addNewChunk: boolean, removeAllChunks: boolean): void {
  let currentBufferSize = getCurrentBufferSize();
  if (addToLocalChunk) {//Small Chunks
    currentBufferSize.chunkSizes[currentBufferSize.chunkSizes.length - 1] += change;
    currentBufferSize.totalBufferSize += change;
    setCurrentBufferSize(currentBufferSize);
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
    setMetaEntryReceiver([]);
  }
  setCurrentBufferSize(currentBufferSize);
  console.log(`Buffer size updated: ${currentBufferSize.totalBufferSize} bytes`, currentBufferSize.chunkSizes); 
}

export function canAddToBuffer(chunkSize: number): boolean {
    return getCurrentBufferSize().totalBufferSize + chunkSize <= MAX_BUFFER_SIZE;
}

export async function removeAllChunksFromSourceBuffer(): Promise<void> {
  let MetaEntryReceiver = getMetaEntryReceiver();
  let sourceBuffer = getSourceBuffer();
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
      setSourceBuffer(sourceBuffer); //evtl Probleme mit dem SourceBuffer
    } catch (error) {
      console.error("Error removing buffer:", error);
      setTimeout(() => removeAllChunksFromSourceBuffer(), 100);
    }
  }
  updateBufferSize(0, false, false, true);
}

export function decrementbufferedBytesSender(reset: boolean = false, chunkSize: number) {
  if(reset){
    setBufferedBytesSender(0);
  }
  else{
    setBufferedBytesSender(getBufferedBytesSender() - chunkSize);
  }
  triggerConditionCheck();
}
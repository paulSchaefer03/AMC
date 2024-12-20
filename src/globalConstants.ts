export const mimeCodec = 'video/webm; codecs="av01.0.08M.08", opus'; // AV1 Codec opus (Sämtliche Header Durations sind FALSCH für AV1)
//export const mimeCodec = 'video/webm; codecs="vp8, vorbis"'; // VP8 Codec
//export const mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'; // H.264 Codec

export const MAX_BUFFER_SIZE = 25 * 1024 * 1024; // 25 MB
export const chunkSize = 256 * 1024; // 256 KB

export const defaultVideoURL = "https://box.open-desk.net/Big Buck Bunny [YE7VzlLtp-4].mp4";
//export const defaultVideoURL = "https://ftp.nluug.nl/pub/graphics/blender/demo/movies/ToS/tearsofsteel_4k.mov";

export const player = document.querySelector("#video")! as HTMLVideoElement;

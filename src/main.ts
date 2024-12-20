import "./style.css";
import {defaultVideoURL, player } from "./globalConstants";
import {initStyle} from "./style";
import { initReceiver } from "./receiver";
import { initSender } from "./sender";
import { initPeer } from "./peer";

//TODO:
//Komische douple seeking Events vom Player verhindern
//Seeling an Ungültige Positionen(BUGS)
//Stream Ending(EndOfStream) nicht immer korrekt
//Speicher und Chache Verwaltung

// Default source
player.src = defaultVideoURL;

initPeer();
initReceiver();
initSender();
initStyle();